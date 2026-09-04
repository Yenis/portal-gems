# wormhole-mini

A portable C implementation of the magic-wormhole client protocol, small
enough to run on a 2009 Nokia E72 (S60 3rd Edition FP2). It is not a binding
to `native/wormhole-core` - the Rust engine cannot be built for Symbian at
all. It is a second, independent implementation that talks to the same
servers with the same app id, which is what makes it a PortalGems peer.

See `docs/SYMBIAN.md` for the plan, the phase list and the protocol
reference this code has to match.

## Layout

- `include/wh.h` - the single public header.
- `src/` - protocol code with no platform dependencies. C89, fixed buffers,
  no floating point, allocation only at startup.
- `port/` - the platform layer. `posix.c` for development and tests on
  Linux, `symbian.cpp` for the phone. The core never touches a socket or a
  file directly; it fills buffers and asks the port to move bytes.
- `cli/` - a host harness binary.
- `tests/` - known-answer tests.
- `tools/genvectors/` - regenerates `tests/vectors/vectors.h` from the same
  crates the engine uses.

## Test vectors

`tests/vectors/vectors.h` is generated and committed. It pins the key
derivation, phase keys, transit subkeys, the literal handshake lines and a
secretbox sample. The generator asserts against the engine's own committed
unit-test vector, so if the engine's crypto ever changes underneath us, the
generator fails rather than silently emitting wrong answers.

```sh
cargo run --manifest-path native/wormhole-mini/tools/genvectors/Cargo.toml \
  > native/wormhole-mini/tests/vectors/vectors.h
```

## Local test harness

Everything through phase S3 is developed against a mailbox server on
localhost, with no phone involved:

```sh
python3 -m venv /tmp/mbvenv
/tmp/mbvenv/bin/pip install magic-wormhole-mailbox-server magic-wormhole
/tmp/mbvenv/bin/twist wormhole-mailbox --port tcp:4000:interface=127.0.0.1

# in another shell, a reference peer on a fixed code
/tmp/mbvenv/bin/wormhole --relay-url ws://127.0.0.1:4000/v1 \
  send --code 7-crossover-clockwork ./payload.txt
```

Note that the mailbox writes `relay.sqlite` into its working directory and
crash-loops if that directory is not writable - the same trap documented for
the production server in `docs/VPS-SETUP.md`.

## Vendored TweetNaCl

`vendor/tweetnacl/` is the canonical 20140427 release from
`https://tweetnacl.cr.yp.to/20140427/`, unmodified and public domain.

```
02e65bc3013ff2168983365e55906bc783c4c7e0a60d8100f17bb303a17175c4  tweetnacl.c
43f29ad721d9927b747b0100ab4160c119e7bb180c7c98a66e4bf79d31244287  tweetnacl.h
```

It supplies XSalsa20-Poly1305 for both phase messages and transit records.
It also carries the ed25519 group arithmetic SPAKE2 needs, but as `static`
internals; the plan is to reach them by compiling `tweetnacl.c` through a
single extension translation unit rather than patching the vendored file, so
it stays byte-identical to upstream and auditable.

TweetNaCl does not implement SHA-256, only SHA-512. Since every wormhole key
is derived with HKDF-SHA256, `src/sha256.c` supplies it.

## Building and testing on the host

```sh
make test     # builds and runs the known-answer tests
make vectors  # regenerates tests/vectors/vectors.h from the engine's crates
make clean
```

`-std=c89` throughout, for the sake of the old Symbian toolchain, but not
`-pedantic`: TweetNaCl and the secretbox wrapper use `long long`, which C89
lacks and every compiler in play supports.
