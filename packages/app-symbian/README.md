# PortalGems for Symbian (Nokia E72, S60 3rd Edition FP2)

The phone side of the client. The protocol itself lives in
`native/wormhole-mini` and is finished and tested on the host; everything
here is platform work.

See `docs/SYMBIAN.md` for the plan and the protocol reference.

## Status

Nothing in this directory has been through a compiler. It cannot be until
the SDK is in place, so treat the `.mmp`, `.pkg` and signing script as a
starting point rather than something known to work.

## What the core needs from the platform

Very little, which is the point:

- **No C library.** `grep -rn "#include <" native/wormhole-mini/src
  native/wormhole-mini/vendor` finds nothing. The core is freestanding, so
  the build links plain Symbian libraries and the phone needs **no Open C /
  PIPS runtime installed**. That is one fewer SIS for the user and one fewer
  thing to go wrong on a fifteen-year-old phone.
- **No allocation after startup.** Large buffers live in static structs
  (`wh_mailbox_bufs`, `wh_xfer_bufs`, about 100 KB together), so the stack
  stays shallow. Symbian still gives a thread only 8 KB by default, which is
  why `whmini.mmp` sets `EPOCSTACKSIZE 0x8000`.
- **Six functions.** `native/wormhole-mini/src/net.h` is the entire platform
  interface: connect, read, write, close, random bytes. `port/symbian.cpp`
  implements it with `RSocket`; the blocking shape maps onto a nested active
  scheduler wait.
- **No filesystem calls in the core.** Received bytes leave through a sink
  callback, so `RFile` stays in the application layer.

## Capabilities and signing

The package asks only for `NetworkServices`, `ReadUserData` and
`WriteUserData`. All three are user-grantable, which is what makes
self-signing sufficient - Nokia's Symbian Signed and Open Signed Online are
long dead, and a developer certificate can no longer be obtained by anyone.
Nothing in this app may ever come to depend on `AllFiles`, `ReadDeviceData`
or `TCB`.

On the phone, once:

- Menu > Settings > App. manager > Software installation = **All**
- Menu > Settings > App. manager > Online certif. check = **Off**

Then `scripts/symbian-sign.sh` generates a certificate on first run, builds
the SIS and signs it.

## Toolchain (Linux)

[GnuPoc](https://github.com/mstorsjo/gnupoc-package) builds S60 3rd Edition
binaries and SIS packages on Linux, without Wine. Two pieces are needed:

1. **The cross compiler.** GnuPoc's `install_csl_gcc_*` script builds
   `arm-none-symbianelf` GCC from the CodeSourcery sources.
2. **The S60 3rd Edition FP2 SDK.** This is the part nobody can automate:
   it is an old Nokia download, no longer distributed by anyone official,
   and has to be sourced from an archive mirror. GnuPoc's `unpack_sdk_*`
   script then unpacks it for use on Linux.

With `EPOCROOT` and `PATH` set as GnuPoc documents:

```sh
cd packages/app-symbian/group
bldmake bldfiles
abld build gcce urel
../../../scripts/symbian-sign.sh
```

## Layout

- `group/bld.inf`, `group/whmini.mmp` - the headless console build, phase S5's
  first target. The GUI application gets its own mmp at S6.
- `src/`, `inc/` - the entry point and, later, the Avkon UI.
- `sis/whmini.pkg` - package definition. The generated certificate, key and
  `.sis` files are gitignored.

Note that `whmini.mmp` deliberately does **not** list
`vendor/tweetnacl/tweetnacl.c`. `src/ed25519.c` compiles it inside its own
translation unit to reach its static ed25519 internals; listing it again
would be a duplicate-symbol link error.
