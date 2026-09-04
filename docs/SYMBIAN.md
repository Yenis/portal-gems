# PortalGems on Symbian (Nokia E72, S60 3rd Edition FP2)

Goal: a PortalGems client that runs on a 2009 Nokia E72 and transfers files
with the desktop and Android apps, over the same servers, using the same
magic-wormhole protocol. Not a port of the app - a second, independent
implementation of the wire protocol, small enough to fit a 600 MHz ARM11
phone, living in this repository so the history stays in one place.

Status legend: `[ ]` todo, `[x]` done, `[~]` in progress.

## 1. Why this is possible at all

The Rust engine cannot come along. There is no Rust target for Symbian: no
LLVM backend for the E32 binary format and its `elf2e32` post-link step, no
`std` port, and `rustls`/`ring` will not build. That path is closed, and no
amount of effort opens it.

What makes the project tractable is that **PortalGems interop is defined at
the wire, not at the library**. From `docs/ARCHITECTURE.md`: the app id is
fixed and any two clients pointed at the same rendezvous server
interoperate, including the reference `wormhole` CLI. So a from-scratch C
client that speaks the protocol correctly is a first-class PortalGems peer.

Two facts make the protocol itself reachable on a 2009 phone:

- **The crypto is small.** Everything needed is TweetNaCl (one portable C
  file: XSalsa20-Poly1305 secretbox, SHA-512, and the ed25519 group
  arithmetic SPAKE2 needs) plus about 200 lines of SHA-256 for HKDF. On an
  ARM11 at 600 MHz a scalar multiplication is well under a second.
- **No TLS is required.** Symbian's TLS stack is TLS 1.0 with a 2009 root
  store and will never reach a modern `wss://` mailbox. It does not have to:
  the transit relay is already plaintext TCP by design (`docs/VPS-SETUP.md`,
  port 4001), and we control the mailbox, so we add a cleartext `ws://`
  listener for legacy clients. SPAKE2 over cleartext is exactly what a PAKE
  is for - an observer on that port learns which code slot was used and
  when, never the key or the file.

## 2. Scope

In scope for v1:

- Receive a single file, transit **relay only**, to the memory card.
- Code entry by keyboard (the E72's best feature) and by generated code.
- Talk to the PortalGems server over cleartext `ws://` on a dedicated port.

Explicitly out of scope for v1, revisit later:

- Directory offers (a `directory` offer is rejected cleanly with a message).
- Direct TCP transit hints (no listening socket, no NAT traversal).
- Transfer protocol v2 / noise, text messages, device pairing.
- `wss://`, and any modern web API without a proxy on the VPS.

Hard constraints from the platform:

- **Capabilities**: only user-grantable ones - `NetworkServices`,
  `ReadUserData`, `WriteUserData`, `UserEnvironment`, `LocalServices`. A
  self-signed SIS can carry these. Anything needing `AllFiles`,
  `ReadDeviceData` or `TCB` requires a developer certificate that can no
  longer be obtained, so nothing may depend on those.
- **C89**, fixed buffers, no floating point, no recursion in parsers,
  allocation only at startup. This is as much about the Symbian toolchain's
  old GCC as it is about the 128 MB of usable RAM.

## 3. Layout

```
native/wormhole-mini/        portable C client core (new)
  Makefile                     host build: `make test`
  vendor/tweetnacl/            canonical TweetNaCl, unmodified, public domain
  include/wh.h                 the single public header
  src/                         platform-free protocol code
    sha256.c/.h                  SHA-256, HMAC, HKDF
    kdf.c/.h                     the protocol's key derivations
    box.c/.h                     secretbox in the nonce||ciphertext format
    spake2.c/.h                  SPAKE2-ed25519, symmetric mode
    json.c/.h                    minimal reader/writer, no allocation
    ws.c/.h                      RFC 6455 client framing
    mailbox.c/.h                 rendezvous state machine
    transit.c/.h                 relay handshake + record framing
    xfer.c/.h                    v1 offer/answer/receive
  port/
    posix.c                      sockets, files, randomness (dev + CI)
    symbian.cpp                  RSocket/RFile equivalents (phase S5)
  cli/wh-mini.c                harness binary for the host
  tests/                       known-answer tests against the Rust engine
packages/app-symbian/        S60 3rd FP2 application (phase S6)
  group/ inc/ src/ sis/        .mmp, .pkg, Avkon UI, signing scripts
```

The core never calls a socket or file API directly; it fills buffers and asks
the platform layer to move bytes. That is what lets the entire protocol be
written and tested on a laptop before the phone is involved at all.

## 4. Protocol reference

Extracted from the vendored engine at `native/magic-wormhole/`. This is the
contract the C client must match. Line references are to that tree.

**App id** (`src/transfer.rs:47`): `lothar.com/wormhole/text-or-file-xfer`.
Never change it; it is what makes us the same application as every other
client.

**Mailbox, JSON over WebSocket** at `ws(s)://host:4000/v1`. Client sends
(`src/core/server_messages.rs`), one JSON object per text frame, `type` field
kebab-case: `bind {appid, side}`, `allocate`, `claim {nameplate}`,
`open {mailbox}`, `add {phase, body}` (body hex), `close {mailbox, mood}`,
`release {nameplate}`, `list`, `ping {ping}`. Server sends: `welcome`,
`allocated {nameplate}`, `claimed {mailbox}`, `message {side, phase, body}`,
`released`, `closed`, `ack`, `pong`, `error {error, orig}`. `side` is 5
random bytes hex-encoded, 10 characters (`src/core.rs:576`).

**Code** is `<nameplate>-<word>-<word>`. The nameplate is the integer slot;
the words come from the PGP even/odd wordlist (`src/core/wordlist.rs`).

**PAKE** (`src/core/key.rs`): SPAKE2 over ed25519, symmetric mode, password =
the full code string, identity = the app id. The `pake` phase body is
`{"pake_v1": "<hex of msg1>"}`. The shared key comes out of the standard
SPAKE2 transcript hash.

**Key derivation** (`src/core/key.rs`): `derive_key(k, purpose)` is
HKDF-SHA256 with no salt, `purpose` as info, 32 bytes out. Phase keys are
`derive_key(k, "wormhole:phase:" || sha256(side) || sha256(phase))` - note
the two digests are raw bytes, not hex. Verifier is
`derive_key(k, "wormhole:verifier")`.

**Phase message encryption**: XSalsa20-Poly1305, wire format is
`nonce (24 bytes) || ciphertext`, hex-encoded into the `body` field. Phases
are the literal strings `pake`, `version`, then `0`, `1`, `2`, ... for
application messages (`src/core.rs:626`).

**Version phase**: `{"abilities": [], "app_versions": {...}}` encrypted under
the `version` phase key. Receiving and decrypting it successfully is what
confirms the code was right.

**Transit key**: `derive_key(k, "<appid>/transit-key")`.

**Relay connection** (`src/transit.rs:1447`): plain TCP to port 4001, send
`please relay <hex of derive_key(transit_key, "transit_relay_token")> for side <side>\n`,
expect exactly `ok\n`.

**Transit handshake** (`src/transit/crypto.rs`), asymmetric. Leader (the
sender) writes `transit sender <hex> ready\n\n` where the hex is
`derive_key(transit_key, "transit_sender")`; follower (us, receiving) writes
`transit receiver <hex> ready\n\n` from `"transit_receiver"`; leader then
writes `go\n`. As the follower we send our line, then expect the leader's
line **plus** `go\n` - 90 bytes exactly. The two lines are **not** the same
length: the sender line is 87 bytes and the receiver line is 89, because
"receiver" is two characters longer than "sender". The engine asserts both
lengths, and it is an easy constant to get wrong. Record keys: the follower encrypts
with `"transit_record_receiver_key"` and decrypts with
`"transit_record_sender_key"`. The names are a historical misnomer for
leader/follower; getting them backwards is the classic bug.

**Records** (`src/transit/transport.rs:33`): 4-byte big-endian length, then
that many bytes, which are `nonce (24) || secretbox ciphertext`. The nonce is
a counter starting at zero, one sequence per direction. Plaintext blocks are
up to 16 KiB.

**Transfer v1** (`src/transfer/v1.rs`), JSON in numeric phases:

- sender to us: `{"transit": {"abilities-v1": [...], "hints-v1": [...]}}`
- us to sender: the same shape with our abilities and hints (relay only)
- sender to us: `{"offer": {"file": {"filename", "filesize"}}}`, or
  `{"offer": {"directory": {...}}}` which v1 rejects
- us to sender: `{"answer": {"file_ack": "ok"}}`
- then the file arrives as transit records
- us to sender, over transit: `{"ack": "ok", "sha256": "<hex>"}`

## 5. Phases

### S0 - Ground truth on the host

- [x] This document, with the protocol reference above.
- [x] Source skeleton under `native/wormhole-mini/`, with its own README.
- [x] Local mailbox server harness verified: a real `wormhole` CLI round trip
      over `ws://127.0.0.1:4000/v1` on a fixed code. Commands in
      `native/wormhole-mini/README.md`.
- [x] Known-answer vectors generated and committed at
      `native/wormhole-mini/tests/vectors/vectors.h`: HKDF outputs, phase
      keys, verifier, transit subkeys, the literal handshake lines and a
      secretbox sample. The generator
      (`native/wormhole-mini/tools/genvectors/`) asserts against the engine's
      own committed unit-test vector, so it fails loudly rather than
      emitting wrong answers if the engine's crypto ever moves.

Retiring the correctness risk here, on a laptop, is the whole point of this
phase. Debugging SPAKE2 on a phone with no debugger would be miserable.

### S1 - Crypto core in C

- [x] TweetNaCl vendored: the canonical 20140427 release from
      `tweetnacl.cr.yp.to`, unmodified, public domain. It supplies
      XSalsa20-Poly1305 and, as static internals, the ed25519 group
      operations SPAKE2 needs (`add`, `scalarmult`, `scalarbase`, `pack`,
      `unpackneg`).
- [x] SHA-256, HMAC-SHA256 and HKDF-SHA256 (`src/sha256.c`). TweetNaCl only
      ships SHA-512, and every wormhole key derivation is HKDF-SHA256, so
      this is the one primitive we supply ourselves.
- [x] Secretbox in the wormhole wire format, `nonce(24) || ciphertext`
      (`src/box.c`). Both calls take a caller-supplied work buffer, so the
      core allocates nothing after startup.
- [x] The protocol key derivations (`src/kdf.c`): `derive_key`,
      `derive_phase_key`, verifier, transit key and its subkeys.
- [x] Host build and `make test`: 24 checks, all green, including
      byte-identical secretbox output against the engine's crate.
- [ ] Expose TweetNaCl's ed25519 group operations for SPAKE2.
- [ ] SPAKE2-ed25519 symmetric mode.

SPAKE2 gets no known-answer vector: both sides pick a random scalar, and the
`spake2` crate does not expose scalar injection, so there is nothing
deterministic to compare against. Its correctness is proven instead by the
live interop milestone in S2 - if the C side computes the same verifier as
the reference client, the PAKE is right. The bug-prone ed25519 group
arithmetic underneath it can still get deterministic tests if S1 turns up
trouble.

### S2 - Mailbox client on the host

- [ ] Minimal JSON reader/writer, minimal WebSocket client.
- [ ] Full rendezvous state machine: bind, allocate or claim, open, pake,
      version, key confirmed.
- [ ] Milestone: `wh-mini` and the `wormhole` CLI agree on the verifier hex
      for the same code against the local mailbox server.

### S3 - Receive a file on the host

- [ ] Relay connect, handshake, record decryption, SHA-256 ack.
- [ ] Milestone: PortalGems desktop sends a file, `wh-mini` receives it
      byte-identically.

At the end of S3 the protocol work is done and proven. Everything after this
is platform work.

### S4 - Symbian toolchain and a signed hello world

- [ ] GnuPoc set up, S60 3rd FP2 SDK unpacked, `arm-none-symbianelf` GCC
      building.
- [ ] Self-signed certificate via `makekeys`, SIS built and signed.
- [ ] Phone set to Software installation = All, online certificate check off.
- [ ] Milestone: a hello-world app installs and runs on the E72.

Deliberately independent of S0-S3, and the thing most likely to eat days.
It can be attempted in parallel at any time.

### S5 - Port the core

- [ ] `port/symbian.cpp`: RSocket connect/read/write, RFile, randomness.
- [ ] Core builds as a static library in the Symbian toolchain.
- [ ] Milestone: a headless console app on the phone receives a file to
      `E:\`.

### S6 - The application

- [ ] Avkon UI: code entry, progress, result, cancel.
- [ ] Server settings, icon, PKG, signed SIS.
- [ ] Milestone: a normal user flow, desktop to phone, start to finish.

### S7 - Sending from the phone

- [ ] File picker, code display, leader-side transit handshake.

### S8 - Ship it

- [ ] Cleartext `ws://` listener documented and deployed
      (`docs/VPS-SETUP.md`).
- [ ] SIS in the release artifacts, checksums in the README.
- [ ] README Symbian section, CHANGELOG entry, ARCHITECTURE.md pointer.

## 6. Open questions

- Which port for the cleartext mailbox listener, and whether to run a second
  mailbox process or rebind the existing one.
- Whether the E72's `E:\` write path needs `WriteUserData` only, or a
  documents-directory API that wants more.
- Wordlist: ship the full PGP list (about 6 KB of strings) or accept
  numeric-only codes on the phone at first.
