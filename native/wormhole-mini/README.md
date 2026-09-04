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
