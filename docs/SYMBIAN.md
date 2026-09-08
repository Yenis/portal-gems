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

- ~~Directory offers~~ - **done**, both directions. See "Folders" below.
- ~~Direct TCP transit~~ - **done**, outbound only. See "Direct transit".
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
    kdf.c/.h                     the protocol's key derivations, hex
    box.c/.h                     secretbox in the nonce||ciphertext format
    ed25519.c/.h                 group ops, exposed from TweetNaCl
    spake2.c/.h                  SPAKE2-ed25519, symmetric mode
    sha1.c/.h, base64.c/.h       for the WebSocket handshake only
    json.c/.h                    minimal reader/writer, no allocation
    ws.c/.h                      RFC 6455 client
    mailbox.c/.h                 the rendezvous state machine
    net.h                        the platform layer's interface
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
- [x] TweetNaCl's ed25519 group operations exposed (`src/ed25519.c`):
      decompress, compress, add, scalar multiplication, scalar reduction and
      negation mod L. `tweetnacl.c` is compiled inside that translation unit
      rather than patched, so the vendored file stays byte-identical to
      upstream. Note that TweetNaCl's `unpackneg` returns the **negated**
      point - it negates x when the parity matches the sign bit, the
      opposite of plain decompression - so the wrapper negates x back and
      recomputes the T coordinate.
- [x] SPAKE2-ed25519 symmetric mode (`src/spake2.c`): password mapped into
      the scalar field, blinding by the constant S, the sorted-transcript
      key, and the 33-byte `0x53 || element` wire message.
- [x] `make test`: 40 checks, all green.

SPAKE2 does get a known-answer vector after all. Both sides normally pick a
random scalar, but the crate exposes `start_symmetric_with_rng`, so feeding
both sides a fixed RNG makes the whole exchange reproducible: the generator
emits the entropy, both messages and the resulting key, and the C code has
to match all three. `Scalar::random` is just a 64-byte fill reduced mod L,
which `wh_sc_reduce_wide` reproduces exactly.

The generator cross-checks itself here too. It recomputes the password
scalar independently and asserts that `basepoint*x + S*pw` equals the msg1
the crate produced, so an error in the replication cannot quietly become a
wrong expected value. Live interop at the S2 milestone remains the real
confirmation, but the offline test now covers the maths.

### S2 - Mailbox client on the host

- [x] Minimal JSON reader/writer (`src/json.c`): top-level key lookup
      returning slices of the original text, no allocation and no recursion
      - nesting is skipped with a depth counter, so a hostile document
      cannot blow the phone's stack.
- [x] WebSocket client (`src/ws.c`) with SHA-1 and base64 for the opening
      handshake (`src/sha1.c`, `src/base64.c`). Masked frames out, ping
      answered, close and fragmentation handled. SHA-1 is used only to
      validate `Sec-WebSocket-Accept` and must never be used for anything
      else here.
- [x] Platform layer split out (`src/net.h`, `port/posix.c`): connect, read,
      write, close, randomness. Deliberately blocking-shaped, because on
      Symbian that becomes RSocket under a nested active scheduler wait and
      presents the same synchronous face to the protocol code.
- [x] Full rendezvous state machine (`src/mailbox.c`): bind, claim, open,
      pake, version, key confirmed. The one asymmetry worth remembering is
      that the `pake` body is plaintext JSON, while every later phase body is
      secretbox-encrypted under a phase key.
- [x] Host harness `cli/wh-mini` with `allocate` and `verify` commands.
- [x] **Milestone met.** Against a local mailbox server, `wh-mini verify`
      and `wormhole send --verify` on the same code both printed
      `898057d65188520a104394a3f48b5dc06f6e9a124508f695f043a5cebe2aff27`.
      The C client completed a real SPAKE2 handshake with the reference
      Python implementation and derived an identical key.
- [x] The wrong-code path was checked too: a mismatched code is not caught
      by SPAKE2, which happily produces a different key, and surfaces
      exactly where the protocol says it should - the peer's `version` phase
      fails to decrypt.

### S3 - Receive a file on the host

- [x] Relay connect, relay handshake, transit handshake in the follower
      role, record framing and decryption (`src/transit.c`). The nonce is a
      big-endian counter and records must arrive in order; a skipped or
      replayed record is rejected rather than decrypted.
- [x] Transfer v1 receive: transit message exchange, offer parsing, answer,
      streaming records, SHA-256 ack (`src/xfer.c`). File bytes leave
      through a caller-supplied sink, so this layer never touches a
      filesystem API - which is what lets the same code serve stdio on the
      host and RFile on Symbian.
- [x] `wh-mini receive` with progress reporting.
- [x] **Milestone met, twice.** A 2.1 MB file arrived byte-identically
      (sha256 `82494fdc...eb16b2ac`) from both the reference Python
      `wormhole send` and, more to the point, from
      `native/wormhole-core`'s own send example - the actual PortalGems
      engine, the same code the desktop and Android apps run. The engine
      reported `SEND-OK`, meaning it accepted the checksum we computed and
      sent back over the transit.

Two limitations, deliberate and worth writing down:

- We ignore the peer's transit hints and connect to our configured relay.
  Both ends being pointed at the same server is exactly how PortalGems
  deploys, so this costs nothing today; honouring their hints is a later
  refinement.
- A `directory` offer is declined with a message rather than unpacked. Zip
  handling on the phone is a separate question and does not belong in the
  first working client.

The protocol work is now done and proven, entirely on the host, against the
real engine. Everything after this is platform work: nothing in `src/` needs
to change to make it run on the phone, only `port/` and the app around it.

### S4 - Symbian toolchain and a signed hello world

- [x] Build scaffolding written: `packages/app-symbian/group/bld.inf`,
      `group/whmini.mmp`, `sis/whmini.pkg`, `scripts/symbian-sign.sh`, and a
      README covering the toolchain and the phone settings. **None of it has
      been through a compiler** - that needs the SDK - so it is a starting
      point, not a known-good build.
- [x] Established that the core is **freestanding**: `grep -rn "#include <"`
      over `native/wormhole-mini/src` and `vendor` finds nothing. No Open C /
      PIPS runtime is needed on the device, which removes an entire
      dependency and an extra SIS the user would have had to install.
- [x] Pre-emptive fixes for things that only bite on the phone: the mailbox
      layer's per-message buffers moved off the stack (a single phase
      message needed about 6 KB, against Symbian's 8 KB default thread
      stack), `EPOCSTACKSIZE` set explicitly, and `wh_json_u32` now rejects
      values a 32-bit build could not represent instead of wrapping.
- [x] **32-bit ARM verified under emulation**, standing in for the phone
      until the SDK arrives. `make test-arm` cross-compiles the whole core
      with `arm-linux-gnueabi-gcc` (ARMv5 soft-float, 32-bit `long` - the
      data model Symbian uses on the E72's ARM11) and runs both suites
      under `qemu-arm-static`: 90 checks, all green, no warnings from our
      own code. Better still, `make cli-arm` builds `wh-mini` for ARM and
      it completed real transfers with `native/wormhole-core` in **both
      directions** under qemu, byte-identical, with the engine confirming
      the checksums. The ARM build allocated `2-waterloo-slingshot` on its
      own wordlist.

      What this proves is the data model: widths, alignment, and a
      different compiler. What it does not prove is any Symbian API, since
      qemu-arm runs Linux. The remaining risk is concentrated in
      `port/symbian.cpp`, which is where it should be.
- [x] **The cross compiler works.** CodeSourcery's servers are gone, but
      Martin Storsjö still mirrors the prebuilt `arm-none-symbianelf` GCC
      3.4.3 that GnuPoc expects. It is an i686 binary and runs as-is here.
      The entire portable core - all 14 files - compiles with it under
      `-Wall -Wextra` and produces **no warnings**. Writing to C89 for a
      2005 compiler turned out to cost nothing.
- [x] **The native tools build**, after three fixes for a modern host,
      captured in `packages/app-symbian/toolchain/gnupoc-modern-host.patch`
      with the reasoning in that directory's README. `elf2e32`, `elftran`,
      `makesis`, `signsis`, `makekeys`, `rcomp`, `bmconv`, `mifconv` and a
      private GNU make 3.81 are all installed. The `signsis` port from
      OpenSSL 1.0 to 3.x was the one that mattered - without it there is no
      installable package at all.
- [x] **S60 3rd FP2 SDK obtained and installed.** The Internet Archive has
      it under exactly the filename GnuPoc expects
      (`S60_SDK_3.2_v1.1.1_en.zip`, 466 MB, item `nokia_sdks_n_dev_tools`).
      Unpacks to 1.1 GB with `install_gnupoc_s60_32`. Note that the
      installer is **not idempotent** - re-running it over an existing
      install aborts partway and leaves the tools unpatched and
      non-executable; delete the target and install fresh instead.
- [x] Three further host fixes, all documented in
      `packages/app-symbian/toolchain/README.md`: the GnuPoc wrapper scripts
      (without them `bldmake` cannot find its own Perl modules), the
      `defined %hash` syntax Perl made a hard error in 5.22, and
      `epoc32/tools/perl` being a *directory* that shadows the real
      interpreter on PATH.
- [x] **Self-signed SIS built.** Not via the SDK's `makekeys`, which shells
      out to an `openssl dsaparam` argument order OpenSSL 3 rejects;
      `scripts/symbian-sign.sh` generates an RSA key and certificate with
      `openssl` directly. Output: `whmini-signed.sis`, 35,188 bytes, of
      which 1,100 is signature and certificate chain.
- [x] Phone set to Software installation = All, online certificate check off.
- [x] **The app installs and runs on the E72.** It appears in the
      applications menu as "PortalGems", launches, draws its console and
      accepts typed input. That means the E32 image, the registration
      resources, the signature and the console all work on real hardware.

Three things had to be fixed after the first install, each obvious only on
the device:

- **UID2 must be 0x100039CE.** With UID2 zero the executable installs to
  `\sys\bin` and is invisible: listed under App. manager as an installed
  package, absent from the applications menu, impossible to launch. The
  registration resources in `packages/app-symbian/data` are the other half
  of this.
- **A platform dependency is required**, not optional. Without one the
  installer cannot confirm the package suits the device and warns "not
  compatible with phone, install anyway?". The E72 wants
  `[0x102752AE]` - S60 3rd Edition FP2.
- **A text console gets raw key codes.** Only accepting `EKeyEnter` left the
  first prompt with no way to submit anything: the natural OK on this phone
  is the joystick centre or the left softkey, which arrive as `EKeyDevice3`
  and `EKeyDevice0` with none of the softkey handling an Avkon application
  would provide.

- **`TInetAddr::Input` does not parse a literal address here.** Given
  `192.168.1.79` it failed, the code fell through to DNS, and the resolver
  tried to look the address up as a host name - returning
  `KErrDndNameNotFound` (-5120). The port now parses dotted quads itself and
  calls `SetAddress`, keeping numeric servers working with no resolver at
  all. The parser's logic is unit-tested on the host, since it cannot be
  tested in place.
- **A named `RConnection` is a convenience, not a requirement.** Treating a
  failed `RConnection::Start()` as fatal stopped the client dead on a phone
  with no usable default connection - while the browser, which manages its
  own access point, worked fine. The port now tries a prompted start, then a
  default start, then falls back to opening sockets straight on the socket
  server via the implicit connection.

- **A text console has no FEP, so the keyboard lies.** On the E72 the keys
  carrying a printed number - r, t, z, f, g, h, v, b, n on this layout -
  arrive at `Getch()` as those digits rather than as letters. There is no
  scan code available through `CConsoleBase` (only `KeyCode` and
  `KeyModifiers`), so the intent cannot be recovered. This wasted most of a
  debugging session: every mistyped code looked like a network fault, and
  the console font is too small to notice the substitution.

  The fix is to stop requiring letters. A code is
  `<nameplate>-<even word>-<odd word>`, the nameplate is numeric, and the
  client already carries both wordlists - so the number is typed and the two
  words are chosen with the D-pad. It also removes a whole class of typo:
  picking cannot produce a word that is not in the list.

  A proper text field with correct input handling comes with the Avkon UI at
  S6. This is the console making do.

Settings also moved out of the binary. `E:\PortalGems\server.txt` holds the
server address, and the app asks for it on first run - a rebuild here means
SDK, repackage, resign and reinstall, which is far too long a loop for a
mistyped address.

Deliberately independent of S0-S3, and the thing most likely to eat days.
The remaining items need the phone and the SDK, so they are the natural
place for work to happen in parallel.

### S5 - Port the core

- [~] `port/symbian.cpp` written: `RSocketServ`/`RConnection`/`RSocket`,
      `RHostResolver` with a literal-address fast path, and `TRandom` for
      randomness. Synchronous style (`User::WaitForRequest`), which suits
      the console build and matches the blocking interface the protocol
      expects; a GUI build must run it off the UI thread.

      One thing to keep an eye on: **`Math::Random` must never be used
      here.** It is a plain PRNG, and every random byte in this program is
      security-critical - the SPAKE2 scalar, secretbox nonces, the
      WebSocket masking key. `TRandom` from `random.lib` is the platform
      CSPRNG and the port panics rather than continue if it fails.
- [~] `packages/app-symbian/src/main.cpp` written: a console app that asks
      for a code and receives one file to `E:\PortalGems\`.
- [x] **Both compile and link.** `abld build gcce urel` produces
      `whmini.exe`, 33,804 bytes, a valid E32 image - `EPOC` magic at 0x10
      and UID 0xE1000001 at offset 8, matching the mmp. The entire portable
      core built for Symbian without a single change to `src/`, which is
      what the platform-layer split was for.
- [x] Verified at runtime. `RSocket`, the access point handling and
      `TRandom` all behave on the device: transfers complete in both
      directions, and a wrong key would fail the version phase or the
      checksum rather than succeed quietly.

Before the first device test, the server constants at the top of
`packages/app-symbian/src/main.cpp` must be changed - they point at
`127.0.0.1`, which on the phone means the phone. Point them at the LAN
address of a machine running the mailbox and relay, or at a deployment.
- [x] The core builds in the Symbian toolchain - compiled straight into the
      application rather than as a separate static library, which is one
      fewer build product for no loss.
- [x] Milestone reached, by a different route than planned: the console app
      was abandoned mid-phase because its keyboard made a wormhole code
      impossible to type, so receiving to `E:\` was first proved by the
      Avkon application in S6 instead.

### S6 - The application

Brought forward, because the console turned out to be unusable rather than
merely ugly: with no FEP, a wormhole code cannot be typed on this keyboard
at all.

- [x] Avkon application (`packages/app-symbian/src/whminiapp.cpp`):
      application, document, app UI and a drawn container, with an Options
      menu and standard softkeys.
- [x] **Real text input.** `CAknTextQueryDialog` is a native editor with a
      real input method, so the keyboard behaves - and the Avkon font is
      legible, which the console font was not.
- [x] **The transfer runs on a worker thread**
      (`packages/app-symbian/src/whminiengine.cpp`). This is a correctness
      requirement, not tidiness: the portable core is synchronous and the
      platform layer waits with `User::WaitForRequest`, which on a thread
      running an active scheduler consumes completions belonging to active
      objects. A plain thread has no scheduler, so the blocking style is
      correct there. The two sides share a `TJob`; the UI polls it on a
      250 ms timer.
- [x] Live progress, and failures reported with stage and Symbian error.
- [x] Settings via the same dialog, persisted to `server.txt`.
- [x] **Cancel.** `Options > Cancel transfer` stops a transfer in progress,
      including one waiting for a peer who never arrives.

      This needed real machinery rather than a flag. The protocol code is
      synchronous, so a transfer spends nearly all its time blocked inside a
      read and cannot poll anything. The UI thread therefore raises a flag
      *and* completes a request in the worker with
      `RThread::RequestComplete`, and the read waits on the socket, the
      timeout and that cancel signal together via `User::WaitForNRequest`.
      Killing the thread would have been simpler and would have leaked the
      socket server session along with everything else it owns.

      The socket read is never abandoned speculatively - cancelling it on a
      timer tick could discard bytes that had already arrived - so it is
      only given up when we really are stopping. A cancelled job says
      "Cancelled" rather than a generic failure, because the user stopping
      something and something going wrong deserve different words.

      Known limit: a cancel during a *write* waits for that write to finish.
      Writes are a single record at most, so the delay is imperceptible.
- [x] Icon. A cut gem, drawn by `packages/app-symbian/gfx/make-icon.py` and
      built into an MBM bitmap/mask pair.

      S60 3rd Edition prefers a scalable MIF icon, but producing one needs
      `svgtbinencode.exe`, a Windows binary, while `bmconv` is native - so
      MBM is the format this toolchain can actually build. The bitmaps are
      generated in code rather than committed as opaque binaries: at 44x44
      there is nothing an editor offers that arithmetic does not, and the
      shape stays reviewable and reproducible.
- [x] **MILESTONE MET.** A 2.1 MB file transferred from the reference
      `wormhole` client to a Nokia E72, over Wi-Fi, code
      `9-paperweight-bison`. The sender reported *"Confirmation received.
      Transfer complete."* - meaning the phone computed a SHA-256 over what
      it received, returned it over the transit, and the sender verified it
      matched.

      Every layer is now proven on real hardware: SPAKE2, HKDF, secretbox,
      the WebSocket client, the mailbox state machine, the transit relay
      handshake, record framing, and the v1 transfer protocol - all in
      portable C89, on a fifteen-year-old phone, interoperating with a
      client that knows nothing about it.

### Over the internet

- [x] Cleartext `ws://` mailbox deployed on the PortalGems server (see
      "Legacy clients" in `docs/VPS-SETUP.md`) - the same mailbox process
      that serves `wss://`, so the phone and the desktop share channels.
      Verified by a transfer between a sender on `wss://` and a receiver on
      `ws://:4000`.
- [x] **A 2.1 MB file transferred from a PC to the E72 through
      `be-my-guest.io`**, code `7-pandemic-newborn`, 293 kB/s, checksum
      confirmed. The phone is a full PortalGems peer over the internet.

Two bugs surfaced only because the phone keeps the application open between
transfers, where the command-line client exits:

- **`rx_phase` was a file-scope static and never reset.** The second
  transfer in a process waited for the phase number the first had reached
  while the peer sent phase 0, and both sides waited for each other. It now
  lives in the mailbox and resets per transfer. `wh-mini` grew a repeatable
  `--code` argument so consecutive transfers in one process are a permanent
  regression test - the only way to catch state that wrongly survives.
- **The shutdown was abrupt**: a `close` message followed immediately by
  dropping the TCP socket, with no WebSocket Close frame, no nameplate
  release and no wait for the server's acknowledgement. The peer then sat
  waiting for a channel that never ended - the sender hung after reporting
  success. Measured: a reference receiver lets the sender exit in about a
  second, ours left it running indefinitely, and it does the same as the
  reference now.

Symbian socket reads also had no timeout at all, so a stall was an
unkillable application rather than an error. They now use an `RTimer`
alongside the read.

## Folders

Feature parity with the desktop and Android apps, which both send folders as
a zip with a `directory` offer. Verified against `native/wormhole-core`: a
tree with nested paths and an empty directory round-trips byte-identically
in both directions, empty directory included.

The pieces, each tested before the next was built on it:

- `src/crc32.c` - a nibble at a time, 64 bytes of table instead of 1 KB.
- `src/inflate.c` - streaming DEFLATE. Input and output are callbacks, so a
  folder of any size decompresses in a fixed 34 KB: the 32 KB window the
  format requires, plus tables. Vectors come from zlib and run at chunk
  sizes 1, 7, 1024 and 100000, because a bit reader refilling mid-code is
  where a hand-written inflate goes wrong.
- `src/zip.c` - reads through a pread-style callback rather than streaming,
  because a zip's real index is the central directory at the end. Entry
  names are checked before use: absolute paths, drive letters, backslashes
  and any `.` or `..` component are refused outright rather than
  normalised, since normalisation is where these bugs live.
- `src/zipw.c` - writes **stored** entries, so sending needs no compressor
  at all. The offer still says `zipfile/deflated` because that is the only
  mode the reference client accepts, but that names the container, not the
  entries. Cross-checked by handing the output to Python's `zipfile`.

On the phone, `RDir` walking is bounded to 16 levels and its file buffer is
static: eight kilobytes per level in a recursive function would exhaust any
thread stack worth having by the third subdirectory. The worker stack was
raised to 96 KB for the same reason.

Both directions stage the archive as a single file. A send has to know its
size before offering it, and a receive wants to read the central directory
at the end - neither is possible while the bytes are still in flight.

## Direct transit

The phone dials out but never listens. The full protocol has both peers
listen and race connections; on a phone an inbound port is nearly always
useless behind carrier NAT, and accepting connections on Symbian would mean
more capability surface and a great deal more code. So the client advertises
the `direct-tcp-v1` ability - which is what makes a peer publish *its*
addresses - offers none of its own, tries the peer's in turn, and falls back
to the relay.

On a local network that is the whole win: the relay moves a couple of
hundred kilobytes a second, a direct connection moves as fast as the wi-fi
will carry. Verified against `native/wormhole-core`, which reports
`TRANSIT:Direct` rather than `TRANSIT:Relay` for files and folders in both
directions.

Two things this needed:

- **Array iteration in the JSON reader.** Hints arrive as a flat array
  mixing direct and relay entries, which is the one place a top-level-key
  reader is not enough. Unknown hint types are ignored rather than treated
  as errors, because the format is explicitly extensible.
- **A bounded connect in the platform layer.** A hint is a guess, and most
  guesses are wrong - a peer advertises every interface it has, including
  virtual bridges and an IPv6 address the phone may have no route to. A
  default connect sits through the operating system's whole retry schedule,
  measured in tens of seconds. `wh_net_connect_timeout` gives each address
  1.5 seconds: non-blocking connect plus `select` on the host,
  `RTimer` alongside `RSocket::Connect` on the phone. The peer waits sixty
  seconds, so this is about not making someone watch a phone screen rather
  than about correctness.

### Three failures between "it works" and it working

Direct transit shipped and the phone stopped transferring at all. Untangling
that took three separate fixes, and they are worth keeping apart because
each had a different shape.

**A thread that would not start.** The first build answered every attempt
with "could not start the transfer" - `RThread::Create` failing, and the
error was being thrown away. The worker had been given a 96 KB stack on the
reasoning that a stack is address space rather than committed memory. That
is true on Linux and false here: Symbian commits the whole thing up front,
and on a phone with the UI already resident there was not 96 KB to be had.
The fix is to ask for less and to keep asking: 64K, 32K, 16K, 8K, taking the
first that is granted. The error code is now shown rather than swallowed,
which is the only reason the next two bugs were findable at all.

**A build script that lied.** `scripts/symbian-sign.sh` had happily
packaged the previous binary after a failed compile, so a build that never
succeeded was installed and tested. It now refuses to sign if any source
file is newer than the binary:

    NEWER=$(find ... -newer "$BINARY" ...)
    if [ -n "$NEWER" ]; then
        echo "refusing to sign: ... the last build did not succeed" >&2
        exit 1
    fi

Cheap, and it removes an entire category of wasted afternoon - the one where
the phone is being blamed for a fix that was never in the package.

### Every wait, bounded and cancellable

The first build with direct transit hung on the phone at 0 percent, and
Cancel did nothing. The dead Cancel was the useful half of that report: the
worker was blocked somewhere the cancel signal could not reach, and there
were exactly four places it could be.

Each of the platform waits had grown its own timer handling, and each had a
fallback for `RTimer::CreateLocal()` failing that read like this:

    if (timer.CreateLocal() != KErrNone) {
        c->socket.RecvOneOrMore(data, 0, status, received);
        User::WaitForRequest(status);

Unbounded, and - the part that matters - waiting on the socket alone, so the
cancel request could complete all it liked and nothing would look at it.
That is precisely "stuck forever, and Cancel does nothing". The comment
above it argued that an unbounded read beat refusing to work, which is true
right up until the read never returns.

Connect, read, write and name resolution now share one helper:

    static TInt WaitBounded(TRequestStatus& aStatus, TInt aTimeoutUs)

It waits on the request, the timer if one could be made, and the cancel
request if one is armed, and returns which of the three won. A caller that
gets anything but `WH_WAIT_DONE` cancels its own operation and collects the
status. There is no path left through the platform layer that can block
without either a deadline or a way out.

### Direct transit is opt-in on the phone

The relay is proven on this hardware over both the local network and the
internet; direct connections are not, and a fast path that hangs is worse
than a slow path that works. So `direct=` in `server.txt` defaults to off,
with a toggle under Options > Settings, and the idle screen says which it
is. With it off the phone's wire behaviour is byte-identical to the builds
that worked - the client advertises no addresses of its own, so the only
thing the setting changes is whether it dials the peer's.

The evidence for the default came from watching what a peer actually
advertises. A desktop on the same wi-fi offered three addresses:

    peer offers 3 direct hint(s): 192.168.1.79:35361,
                                  192.168.122.1:35361, 10.0.2.2:35361

One reachable, and two - a libvirt bridge and a QEMU NAT address - that the
phone has no route to and never will. Dialling those is where it sat. A
bounded connect makes that survivable; it does not make it a good default.

The version is on the main screen for the same reason: when a build
misbehaves, the report arrives as a photograph of a phone.

v0.5.3 is confirmed working on the E72, sending and receiving over the
internet through the PortalGems server.

## The bug that cost the most

Worth writing down, because it was invisible from every angle.

The console mapped the `.` key to `-`, so a server address typed as
`192.168.1.79` was stored as `192-168-1-79`. That went into
`E:\PortalGems\server.txt`, where it **outlived the console app itself**.
Every later build dutifully asked the resolver for a host named
`192-168-1-79` and got `KErrDndNameNotFound` (-5120) - a completely correct
answer to a question nobody meant to ask.

The error code was right from the first report. What was missing was any way
to see the string being used: the display showed `Server: 192.168.1.79`
because that is what a human reads when the characters are that small, and a
hyphen and a dot are two pixels apart.

Three lessons, all cheap in hindsight:

- **Echo inputs back with delimiters.** `host [192-168-1-79] len 12` would
  have ended this in one round trip. It was added at the very end.
- **Persisted settings outlive the bug that created them.** The keyboard was
  fixed two builds before the transfer worked; the corrupted file kept the
  symptom alive.
- **A keyboard with no input method is not a keyboard.** Everything
  downstream is guesswork until text input is trustworthy, which is why the
  Avkon UI stopped being a nicety and became the fix.

The console build (`src/main.cpp`) is gone; the four days of Symbian
behaviour it taught us are recorded above.

### S7 - Sending from the phone

The protocol half is done and verified on the host, ahead of the platform
work, so that the S5 port delivers a complete client rather than a
receive-only one.

- [x] `wh_mailbox_allocate`: ask the server for a nameplate and build a full
      code from it.
- [x] The PGP wordlist (`src/wordlist.c`, generated by
      `tools/genwordlist.py` from the engine's own `pgpwords.json`), so a
      code shown on the E72 looks like a code from any other client. A
      two-word code takes its first word from the even list and its second
      from the odd list - `crossover-clockwork` is even-odd, which is what
      pins the orientation.
- [x] Leader role in the transit handshake (`src/transit.c`), including the
      reversed record keys: the leader sends with
      `transit_record_sender_key`, the follower with the receiver key.
- [x] `wh_xfer_send_file`: offer, answer handling, streaming records,
      checking the peer's returned checksum against ours.
- [x] `wh-mini send`.
- [x] **Verified against the engine**: `wh-mini` allocated
      `6-pioneer-dreadful`, `native/wormhole-core`'s recv example reported
      `RECV-OK`, and the file arrived byte-identical.
- [x] The phone half. `Options > Send file` opens the phone's own file
      browser (`AknCommonDialogsDynMem::RunSelectDlgLD`, so it browses phone
      memory and the card exactly as every other S60 application does),
      then shows the allocated code for the other side to type, and reports
      progress while sending.

      Sending needs no text input at all, which makes it the easier
      direction on this phone - the code is displayed, not typed.

### S8 - Ship it

- [x] Cleartext `ws://` listener documented and deployed
      (`docs/VPS-SETUP.md`), and carrying real transfers.
- [ ] SIS in the release artifacts, checksums in the README.
- [ ] README Symbian section, CHANGELOG entry, ARCHITECTURE.md pointer.

## 6. Open questions

- Which port for the cleartext mailbox listener, and whether to run a second
  mailbox process or rebind the existing one.
- Whether the E72's `E:\` write path needs `WriteUserData` only, or a
  documents-directory API that wants more.
- Wordlist: ship the full PGP list (about 6 KB of strings) or accept
  numeric-only codes on the phone at first.
