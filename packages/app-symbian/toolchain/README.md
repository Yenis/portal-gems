# Building the Symbian toolchain on a modern Linux host

Everything here is about getting a 2008 SDK and a 2005 cross compiler to
work on a 2026 machine. The application build itself is documented one level
up, in `packages/app-symbian/README.md`.

Target: Ubuntu 24.04 x86-64. Nothing is installed system-wide except two
distribution packages.

## What goes where

Everything lands in `~/symbian-sdk`, outside the repository:

```
~/symbian-sdk/
  S60_SDK_3.2_v1.1.1_en.zip     the SDK, 466 MB
  gnupoc-package/               the build scripts, patched (see below)
  csl-gcc/                      the cross compiler and the native tools
  s60_32/                       the unpacked SDK (EPOCROOT)
```

## 1. The cross compiler

CodeSourcery's own download servers are long gone; Martin Storsjö still
mirrors the packages GnuPoc expects.

```sh
mkdir -p ~/symbian-sdk && cd ~/symbian-sdk
curl -LO https://www.martin.st/symbian/gnu-csl-arm-2005Q1C-arm-none-symbianelf-i686-pc-linux-gnu.tar.bz2
mkdir -p csl-gcc && tar -jxf gnu-csl-arm-*-i686-pc-linux-gnu.tar.bz2 -C csl-gcc
csl-gcc/bin/arm-none-symbianelf-gcc --version   # 3.4.3 (CodeSourcery ARM Q1C 2005)
```

This is a 32-bit i686 binary. It runs as-is if the machine has 32-bit
runtime support; if `--version` fails with "No such file or directory", the
loader is missing and you need `sudo dpkg --add-architecture i386 && sudo
apt install libc6:i386`. Building the compiler from source instead is
possible (`install_csl_gcc`, needs flex and bison) but a 2005 GCC does not
enjoy being compiled by GCC 13.

**GCC 3.4.3 is why the client is written in C89.** It is not a modern
compiler, and the whole of `native/wormhole-mini/src` compiles under it with
`-Wall -Wextra` and no warnings.

## 2. The native tools

```sh
cd ~/symbian-sdk
git clone https://github.com/mstorsjo/gnupoc-package.git
cd gnupoc-package
git apply /path/to/portal-gems/packages/app-symbian/toolchain/gnupoc-modern-host.patch
cd tools
./install_eka2_tools ~/symbian-sdk/csl-gcc
```

That builds `elf2e32`, `elftran`, `makesis`, `signsis`, `makekeys`,
`rcomp`, `bmconv`, `mifconv` and a private copy of GNU make 3.81.

`gnupoc-modern-host.patch` is required: GnuPoc was last touched in 2016 and
three things have moved since.

- **`bmconv`** compares a `char*` against `0` with `>`, which GCC 13 rejects
  outright. Fixed to `!= 0`, and the tool's own `CFLAGS` gain `-fpermissive
  -std=gnu++98` because it is full of other 2003-era C++.
- **`makesis`/`signsis`** are written against OpenSSL 1.0. `EVP_PKEY`,
  `EVP_MD_CTX` and `X509_OBJECT` all became opaque in 1.1, `EVP_dss1` and
  `ERR_GET_FUNC` were removed, and `X509_OBJECT_free_contents` went with
  them. Ported: contexts are heap-allocated through `EVP_MD_CTX_new`, key
  type comes from `EVP_PKEY_base_id`, `EVP_sha1` replaces `EVP_dss1` (which
  was only ever SHA-1 tagged for DSA), the error checks drop the removed
  per-function codes and match on library plus reason, and the
  `X509_OBJECT` dance that only ever freed a certificate is now
  `X509_free`. This is the part that matters most: no `signsis`, no
  installable package.
- **GNU make 3.81** will not link against modern glibc - `__alloca` and
  `__stat` are no longer exported. Its configure line gains defines mapping
  those to the public names.

## 3. The SDK

The S60 3rd Edition FP2 SDK is an old Nokia download that nobody
distributes officially any more. The Internet Archive has it, and GnuPoc
expects that exact filename:

```sh
cd ~/symbian-sdk
curl -LO https://archive.org/download/nokia_sdks_n_dev_tools/S60_SDK_3.2_v1.1.1_en.zip
cd gnupoc-package/sdks
./install_gnupoc_s60_32 ~/symbian-sdk/S60_SDK_3.2_v1.1.1_en.zip ~/symbian-sdk/s60_32
```

Unpacking needs `unshield` (the SDK ships InstallShield cabinets) and
`unzip`, both from the distribution.

The same Internet Archive item also holds
`nokia_eseries_sdk_plug_in_for_s60_3rd_ed_fp2_v1_0_en.zip`, which adds
Eseries-specific APIs. The client does not need it - it uses plain sockets -
but it exists if the UI ever wants E72 hardware keys.

## 4. Wrapper scripts

Do not skip this. The wrappers are what make the SDK's Perl tools behave on
a case-sensitive filesystem with forward slashes; without them `bldmake`
fails with `Can't locate E32env.pm in @INC` and an `@INC` full of
backslashes.

```sh
cd ~/symbian-sdk/gnupoc-package/sdks
./install_wrapper ~/symbian-sdk/gnupoc
sed -i 's|^EKA2TOOLS=.*|EKA2TOOLS=~/symbian-sdk/csl-gcc/bin|' \
    ~/symbian-sdk/gnupoc/gnupoc-common.sh
```

## 5. Two more fixes for a modern host

```sh
python3 packages/app-symbian/toolchain/fix-sdk-perl.py \
    ~/symbian-sdk/s60_32/epoc32/tools
```

That script does two things:

- **`defined %hash` / `defined @array`.** Deprecated in Perl 5.6 and a hard
  error since 5.22, so `bldmake bldfiles` dies immediately in
  `e32plat.pm`. GnuPoc was last touched in 2016 and does not cover it. The
  script is a balanced-expression scanner rather than a regex on purpose: in
  `if (defined %{$Plat{$BSF}}) {` the trailing paren belongs to the `if`,
  and a regex with an optional `)` eats it, silently producing a syntax
  error further down the file.
- **`epoc32/tools/perl` is a directory** - the SDK ships a Windows Perl
  distribution under that name. Since `epoc32/tools` goes on PATH ahead of
  `/usr/bin`, `make` running `perl -S makmake.pl` finds the directory and
  dies with `perl: Permission denied`, which looks nothing like the real
  problem. The script renames it to `perl.win32-unused`.

Note also that **the SDK installer is not idempotent**: running it a second
time over an existing installation aborts partway (on an existing symlink,
then on a non-empty directory) and can leave the tools unpatched and
non-executable. If it fails, delete the target directory and install fresh.

## 6. Environment

```sh
export EPOCROOT=~/symbian-sdk/s60_32/
export PATH=~/symbian-sdk/gnupoc:$PATH
```

## 7. Building

```sh
cd packages/app-symbian/group
bldmake bldfiles          # writes makefiles under $EPOCROOT/epoc32/build/<abs path>
abld build gcce urel      # -> $EPOCROOT/epoc32/release/gcce/urel/whmini.exe
../../../scripts/symbian-sign.sh
```

`bldmake` writes nothing into the source directory - its output goes under
`$EPOCROOT/epoc32/build/` followed by the *absolute path* of the project, so
looking for an `abld.bat` next to `bld.inf` is misleading. Run `bldmake -v
bldfiles` to see where it actually put things.

Expect a stream of `Use of uninitialized value` warnings from the SDK's Perl.
They are harmless - `bldmake.pl` reads an optional second argument that is
not supplied.

## 8. Signing

`scripts/symbian-sign.sh` does not use the SDK's `makekeys`: it shells out to
`openssl dsaparam -genkey 2048 -out ...`, an argument order OpenSSL 3
rejects. The script generates an RSA key and a self-signed certificate with
`openssl` directly, which is simpler than patching another tool and gives
the key type `signsis` prefers anyway.

One `.pkg` gotcha: the language block (`&EN`) has to come **before** the
package header (`#{...}`), or `makesis` reports "the languages have already
been defined".
