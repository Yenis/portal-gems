# Extracting the wormhole engine - feasibility study

Research date: 2026-09-11, against `master` at `abed80e`. Question: can the
wormhole engine leave this repository and become a package that PortalGems and
future apps consume for their network transfers, and what would that take?

## 1. Summary

**Verdict: feasible, and the code is closer to ready than the repository
layout suggests.** The engine has no dependency on anything under
`packages/`. It has no UI, no i18n and no storage, and servers are already
passed in on every call. The Rust wrapper is about 790 lines of logic plus 330
lines of tests. The two binding layers are about 280 lines each.

The code is not what makes this expensive. The cost is in four other places:

1. **The implicit API becomes a public contract.** Errors cross the FFI as
   display strings, and `packages/core/src/errors.ts` regex-matches them,
   including strings written by upstream magic-wormhole. Transit info is a
   `Debug`-formatted string. Folder offers overload `file_name`/`file_size`.
   Every one of these is fine inside one repo, but they would break
   consumers once the package is published.
2. **Native binary distribution for three runtimes.** crates.io, npm
   prebuilds for Electron, and a React Native module whose Android
   static libraries are 45-55 MB each in release (216-297 MB in debug).
3. **The vendored magic-wormhole fork.** Upstream is still at 0.8.1, released
   2026-05-07, and has neither of your patches (directory offers, text
   messages). crates.io does not accept path or git dependencies. So the fork
   has to be upstreamed, published under a new name, or kept off crates.io.
4. **Licensing.** The engine is GPL-3.0-or-later, which forces every
   consuming app to be GPL-compatible. The RN package claims MIT, but it
   bundles the GPL engine, so that label is wrong today either way.

**Scope caveat.** Magic-wormhole is a one-shot, two-party protocol built
around a meeting point: both devices must be online at the same moment and
share a code or a pre-shared secret, and both depend on a mailbox server. It
is a very good transport for "hand this to that device" and for bootstrapping
secure device-to-device channels. It is not a general networking layer: it
has no persistent sessions, no many-to-many, and no store-and-forward. Section
4 has a fit table to check future apps against.

**Recommendation.** Do it in three steps, and let the second app drive the
final API:

- **Now, in this repo:** the behaviour-preserving cleanups in section 8,
  phase 1 (split uniffi out of the core crate, remove PortalGems names from
  the engine, move the desktop TS types next to the addon). These are useful
  even if the extraction never happens.
- **Next, still in this repo:** harden the API (structured errors, a tagged
  offer type, configurable app id, timeouts). Breaking changes cost nothing
  while PortalGems is the only consumer.
- **When the second app starts:** move the engine into its own repository.
  Consume it from git tags first. Publish to public registries only once two
  real apps have shaped the API.

## 2. What "the engine" is today

It is a stack of layers, not one crate:

| Layer | Path | Size | Role |
|---|---|---|---|
| Protocol library (vendored fork) | `native/magic-wormhole` | ~10.5k lines Rust, EUPL-1.2 | magic-wormhole.rs 0.8.1 plus two patches: directory offers, text messages (`PORTALGEMS-PATCH.md`) |
| Engine | `native/wormhole-core/src/lib.rs` | 1,113 lines (~330 tests) | App-shaped API: send file/folder/zip/text, request-then-accept receive, cancellation, safe naming, zip-slip and zip-bomb guards, server config, rustls for `wss://` |
| UniFFI surface | `native/wormhole-core/src/ffi.rs` | 278 lines | `TransferListener` callback trait, `IncomingFile` object, async exports |
| Electron addon | `native/wormhole-node` | 272 lines | napi-rs 2, strings/f64 only (V8 memory cage), id-registry for cancel/accept/reject |
| Electron loader + types | `packages/app-desktop/src/engine.ts` | ~95 lines | Platform-suffixed `.node` loading, hand-written TS interface |
| React Native module | `packages/wormhole-rn` | generated + C++ | ubrn 0.31 C++ turbo-module, prebuilt `libwormhole_core.a` per ABI |
| Engine-adjacent TS | `packages/core/src/{servers,errors,pairing}.ts` | 142 / 33 / 266 lines | Server picker model, engine-error mapping, pairing protocol |
| Pairing orchestration | `app-mobile/src/pairing.ts`, desktop `main.ts` + `renderer/pairing.ts` | 175 lines on mobile | Polling loop over derived codes, per-attempt bound, handshake - implemented once per app |
| Second implementation | `native/wormhole-mini` | ~3.6k lines C89 + ports | Independent protocol client for Symbian; shares only the wire format and test vectors |

Health check on 2026-09-11: `cargo test` in `wormhole-core` passes 9 unit
tests, and the 3 network round-trip tests are `#[ignore]`d as designed.

## 3. Is it separable?

### 3.1 What is already clean

- **Dependencies point one way.** The engine and its bindings import nothing
  from `packages/core` or the apps. The apps import the engine.
- **No PortalGems policy in the engine.** Server URLs are injected per call,
  and the defaults are the public community servers. The PortalGems server
  lives in `packages/core/src/servers.ts`, which is the right place.
- **Standard app id.** The engine keeps magic-wormhole's
  `lothar.com/wormhole/text-or-file-xfer`, which gives interop with the CLI,
  Warp and others on the same server for free.
- **Executor-agnostic futures.** magic-wormhole runs on async-io/smol and
  blocking work goes through the `blocking` pool. That is why napi (tokio)
  and UniFFI (the foreign executor) can both drive the same futures, and it
  is the property a library wants.
- **Safety work that another app would otherwise have to redo:**
  sanitized names, no-clobber `name (n)` naming, zip-slip rejection, an
  unpack cap of claim + 25% + 16 MiB, cancellation that also covers the
  waiting phase, and a confirm-before-accept flow.

### 3.2 PortalGems residue inside the engine (small, mechanical)

| Item | Where | Fix |
|---|---|---|
| Crate descriptions say "PortalGems" | both `Cargo.toml` | Rename |
| Temp workspace prefix `pg-sendfolder-` | `lib.rs` `send_folder` | Neutral prefix, or a caller-supplied temp dir |
| `create_test_file` (phase-0 spike helper, writes `portalgems-test-*.bin`) is a public FFI export | `ffi.rs`, `wormhole-node` | Move to examples/tests |
| `uniffi` is a hard dependency and `setup_scaffolding!` lives in `lib.rs` | `wormhole-core` | Split into a pure `engine` crate and an `ffi` crate. Today the napi addon compiles UniFFI scaffolding it never uses |
| `ubrn-postgen.sh` restores `CMakeLists.txt` with `git checkout --` | `packages/wormhole-rn/scripts` | Copy from a tracked template instead. The current script only works inside this git repo, and it mutates the working tree |
| `ubrn.config.yaml` points at `../../native/wormhole-core` | `packages/wormhole-rn` | Point it at the crate inside the new repo |
| Desktop TS types live in the app | `app-desktop/src/engine.ts` | Ship them with the addon (napi-rs can generate `index.d.ts`) |
| RN package says `"license": "MIT"` | `packages/wormhole-rn/package.json` | Align with the licensing decision (section 6) |

### 3.3 Implicit contracts that would become public API (the real work)

1. **Errors are strings.** `Error` is `#[uniffi(flat_error)]`, and napi uses
   `Error::from_reason(e.to_string())`, so foreign code only ever sees
   display text. `friendlyError` matches on phrases like `nameplate is
   unclaimed` and `rendezvous`. Those come from upstream's `WormholeError`,
   which is `#[non_exhaustive]` and free to reword in any release. A public
   package needs a stable `ErrorKind` (for example `InvalidCode`,
   `CodeNotFound`, `WrongCode` (PAKE failed), `Crowded`, `Cancelled`,
   `Timeout`, `Rejected`, `PeerGone`, `ServerUnreachable`,
   `InvalidServerUrl`, `Archive`, `Io`, `Protocol`, `Other`) plus a message,
   in both bindings. Side finding: `PakeFailed` (mistyped code, or someone
   guessing codes) currently falls through to the generic "transfer failed"
   text.
2. **Transit info is `format!("{:?} peer={}")`.** It should be a record like
   `{ kind: direct | relay, peer }`.
3. **Folder offers overload the file fields.** For a directory offer,
   `file_name` and `file_size` describe the zip, and the real information is
   in `folder`. A tagged union `Offer = File | Folder | Text` is the public
   shape.
4. **I/O works only on paths.** Send takes a path, and receive writes into a
   directory. Android already needed workarounds for this: SAF copies into
   the cache, and Kotlin zips the tree itself. Other apps will want to send a
   generated blob or receive into memory. The engine needs
   `AsyncRead`/`AsyncWrite` at the Rust level, and in the bindings a
   bytes-in/bytes-out variant for small payloads.
5. **There are no timeouts.** This is a known gap: with Wi-Fi off, connect
   hangs until cancelled. The pairing loop works around it with a per-attempt
   `AbortController`, reimplemented in each app. A library should take a
   connect timeout and an overall timeout.
6. **Caller-allocated ids in process-global maps.** The napi addon keys
   `CANCELS`/`RECEIVES` by an id the caller picks. Two independent consumers
   in one process could collide. A library should hand out handles. The
   napi-rs 2 async-method lifetime problem that motivated the registry is
   worth re-checking against napi-rs 3 before redesigning.
7. **The verification string is not exposed.** `Wormhole::verifier()` exists
   upstream. Apps that care about active attackers (anyone doing more than
   casual file drops) will want to show it.
8. **Cancellation differs by platform.** On RN, cancel drops the future
   (`AbortSignal`), so the peer sees a dropped connection. On desktop, a
   cancel future is passed into `accept`. Pick one semantic and document it.

## 4. What future apps can use it for

| Use | Fit | Notes |
|---|---|---|
| Hand a file, folder or text to another device | Excellent | What the engine does today, wire-compatible with every magic-wormhole client |
| Device pairing, then code-less transfers between owned devices | Excellent | PortalGems' derived-code scheme generalizes; see 4.1 |
| Sending an export, backup or config to another device (in memory) | Good, after API work | Needs the bytes/stream API (3.3 item 4) |
| App-specific protocols (small encrypted messages plus a bulk encrypted stream) | Possible, not exposed | The vendored crate has `Wormhole::send/receive` (encrypted mailbox messages), `transit` connectors, and an experimental `forwarding` (TCP port forwarding) feature. The wrapper exposes none of it |
| Long-lived sessions, reconnecting links, background sync | Poor | That is the "Dilation" protocol, which exists in the Python implementation and not in magic-wormhole.rs (no trace of it in the vendored source) |
| Many-to-many, broadcast, offline delivery, request/response APIs | Wrong tool | Both peers must be online together and share a code or secret |

**Decide the app id per app.** Keeping the standard file-transfer app id
means CLI interop, which is PortalGems' promise. A custom app id isolates an
app: its codes cannot be joined by the CLI or by your other apps. The engine
currently hard-wires the standard one (`app_config`). Make it a parameter,
with the standard id as the default.

**The server becomes shared infrastructure.** One mailbox server and relay
serve any number of app ids, so `be-my-guest.io` can carry the whole product
family. That also makes it a single point of failure, and its capacity and
abuse handling become a product-family concern. Keep the public community
server as a fallback, not as the default target for heavy app traffic.

### 4.1 Pairing belongs in the package - eventually

Pairing is the most reusable thing PortalGems has built on top of wormhole
("my devices find each other without typing codes"). Today the pieces are
spread out:

- Derivation (HMAC over a 300 s bucket, candidates `[b, b-1, b+1]`) and the
  payload format are in `packages/core/src/pairing.ts`.
- The polling loop, the 10 s per-attempt bound and the handshake are
  implemented separately on mobile and on desktop.

Moving derivation and polling into Rust would give every binding, including
non-JS apps, one implementation. Two compatibility constraints come with it:

- The derivation label `portalgems-code-v1:` and the frozen test vector must
  stay byte-identical for PortalGems. New apps should use their own label
  (domain separation), so that a pairing made in one app cannot open codes in
  another.
- The handshake is still sent as a file (`pg-pair-handshake.json` through
  `sendFile`/`receiveFile`). A library would naturally use text messages, but
  an older PortalGems receiver calls `receiveFile`, and that fails with
  `NotAFileOffer` on a text offer. Keep a compat mode for PortalGems.

## 5. Distribution per runtime

| Runtime | Today | For a separate package | Effort |
|---|---|---|---|
| Rust | Path deps | crates.io rejects path and git deps, so the fork needs a crates.io home first (6.2). Your own apps can use git deps pinned to tags right away | Low |
| Node / Electron | CI builds linux-x64, win32-x64, darwin-arm64; the loader picks `wormhole_node-<platform>-<arch>.node` | Standard napi-rs layout: one optional-dependency package per platform plus a loader. A public package is expected to add darwin-x64 and linux-arm64. The linux addon is 12.8 MB (release). The Electron rule (no external ArrayBuffers) must stay a design constraint for any bytes API | Medium |
| React Native Android | Prebuilt `libwormhole_core.a` per ABI, linked by the app's CMake | Static archives cannot ship on npm: 45-55 MB each in release, 216-297 MB in debug, three ABIs. Options: (a) consumers build Rust from source (needs rustup targets + cargo-ndk + NDK; fine for your own apps, and it is what F-Droid wants anyway); (b) ship release `.so` or an AAR through Maven or GitHub Packages; (c) download at install time (hostile to F-Droid, avoid). Keep (a) always possible, and add (b) for a public release | High |
| React Native iOS | Never built (codegen and podspec only) | ubrn supports iOS, and rustls/ring build for Apple targets. This is new work plus device testing, only if a future app targets iOS | Medium-high |
| C89 `wormhole-mini` | Symbian-only consumer | Could move into the same repo as a conformance peer. Its test vectors are generated from the same crate versions (`tools/genvectors`), so co-locating it makes drift harder | Low |

**A packaging hazard this study turned up.** The `jniLibs` in
`packages/wormhole-rn` currently hold the **debug-profile** engine:

- They are byte-identical to `target/aarch64-linux-android/debug`, built on
  2026-09-09, with 256 codegen units per crate.
- The local release APK built on 2026-09-11 links them. Its
  `libappmodules.so` is 36.4 MB for arm64-v8a. The shipped v1.0.0 APK's is
  10.1 MB, and both files are stripped.

CI runs `yarn ubrn:android:release` from a clean checkout, so tagged releases
are not affected. Any locally assembled "release" APK is, though. A package
with a pinned release build removes this class of mistake. Until then, run
`yarn ubrn:android:release` before a local `assembleRelease`.

## 6. Licensing

This section is not legal advice. It lists the points to settle, and a lawyer
should confirm them if closed-source apps are ever in the plan.

### 6.1 Your code

`git shortlog` shows a single author (Yenis) for `native/`,
`packages/wormhole-rn` and `packages/core`. That means the license of the
wrapper crates and bindings is entirely your decision:

- **Keep GPL-3.0-or-later.** Simple, and consistent with PortalGems. Every
  consuming app (yours or anyone's) must be GPL-compatible open source.
- **MPL-2.0 or LGPL-3.0.** Weak copyleft: changes to the engine stay open,
  and apps of any license can link it.
- **MIT / Apache-2.0.** Maximum reach, but the compiled artifact still
  contains EUPL code (6.2), so "permissive" is only true of your part.
- Whatever you choose, fix the RN package's `MIT` label, and ship a
  third-party notice file (generated with `cargo-about` or `cargo-deny`).

### 6.2 The vendored magic-wormhole

- It is EUPL-1.2, and your two patches are modifications of it. The fork
  stays EUPL-1.2, and its source must be available wherever you distribute
  it.
- EUPL-1.2's compatibility clause lists GPL-2/3, LGPL, MPL-2.0 and others,
  which is how PortalGems is GPL today.
- Whether statically linking EUPL code into a closed app creates a
  derivative work is contested. The EUPL's authors argue that linking for
  interoperability does not, but that is not settled.
- **Getting the patches upstreamed** removes the fork and the crates.io
  blocker together. Upstream's README still lists text messages as missing
  and folders as tarballs, so both patches fill known gaps. The patch notes
  already call them upstreamable.

### 6.3 Dependencies

There are 321 crates in the normal and build dependency graph. Nearly all
are MIT and/or Apache-2.0. The rest:

- MPL-2.0: `uniffi` (8 crates)
- Unicode-3.0: ICU crates, via `url`/`idna`
- CDLA-Permissive-2.0: `webpki-roots`
- ISC: `ring`, `rustls-webpki`
- BSD-3-Clause: `curve25519-dalek`, `x25519-dalek`, `subtle`

None of them constrains the choice in 6.1. `wormhole-mini` vendors TweetNaCl,
which is public domain.

## 7. Proposed shape

A separate repository. "wormhole-kit" is a placeholder name; note that the
unscoped npm name `react-native-wormhole` is taken by an unrelated package,
so use a scope such as `@gemstech/...`.

```
wormhole-kit/
  crates/
    magic-wormhole/     vendored fork + PATCH notes (EUPL-1.2), removed once upstreamed
    wormhole-engine/    today's lib.rs: pure Rust API, no FFI deps
    wormhole-ffi/       today's ffi.rs: UniFFI surface (cdylib/staticlib)
    wormhole-node/      napi-rs addon + generated index.d.ts + loader (today's engine.ts)
  packages/
    wormhole-rn/        ubrn module built from crates/wormhole-ffi
  c/wormhole-mini/      optional: C89 implementation + vectors
  conformance/          interop runs: engine <-> Python CLI <-> wormhole-mini, local mailbox
  .github/workflows/    cargo test, network tests vs a local mailbox, napi matrix, Android libs
```

The public API should be one conceptual model mirrored in every binding. The
TypeScript below is only an illustration:

```ts
const tx = wormhole.send(
  { kind: 'file', path } /* | folder | zippedFolder | bytes | text */,
  { server, appId, code /* allocate | exact */, timeouts, onEvent }
);
tx.cancel();
await tx.done;

const offer = await wormhole.receive(code, { server, appId, signal });
// offer.kind: 'file' | 'folder' | 'text'; offer.verifier
await offer.accept({ dir });          // or accept({ memory: true }), offer.reject()
// errors: WormholeError { kind: ErrorKind, message }
```

PortalGems-only concerns stay in PortalGems: the server picker and its
defaults, i18n error text (switching on `kind` instead of a regex), storage
of pairings, the Android SAF/MediaStore layer, and the Electron IPC.

## 8. Migration plan

Every phase leaves PortalGems shippable. The effort figures are rough ranges
for one developer who knows this code, not commitments.

| Phase | Work | Verify with | Effort |
|---|---|---|---|
| 1. In-repo cleanup, no behaviour change | Split `wormhole-core` into engine and ffi crates; remove PortalGems names; move `create_test_file` out of the public surface; move desktop types next to the addon; replace the `git checkout` postgen step with a template copy; fix the RN license field | `cargo test` (+ `--ignored`), desktop smoke flows, one Android E2E on device, Python CLI interop | 2-4 days |
| 2. API hardening, in-repo | Structured errors in both bindings plus `errors.ts` switching on kind; tagged `Offer`; typed transit info; configurable app id; timeouts; verifier; bytes variants; handle-based node API; one cancellation semantic | Same as phase 1, plus new unit tests per error kind; mobile needs `yarn ubrn:android` + `yarn prepare` + Metro `--reset-cache` | 1-2 weeks |
| 3. Move out | New repo with history (`git filter-repo` over `native/` and `packages/wormhole-rn` - you run git); CI there including network tests against a local mailbox; PortalGems consumes git tags; delete the in-repo copies; update `docs/ARCHITECTURE.md` and the build gotchas | PortalGems CI release build from the tag, all six artifacts | 3-5 days |
| 4. Publish (optional) | napi prebuild packages, RN distribution choice (5), docs, semver 0.x, changelog, notice file; upstream PRs to magic-wormhole.rs in parallel | Install into a fresh Electron app and a fresh RN app from the registry | 2-4 days + upstream wait |
| 5. Extensions, when an app needs them | Pairing in Rust with a PortalGems compat mode; custom-protocol primitives (message channel + transit stream); iOS | Frozen pairing vector still passes; cross-version PortalGems pairing | 1-2 weeks each |

For day-to-day development after phase 3, use `[patch]` in Cargo and a
`file:` override in npm pointing at a sibling checkout. That brings back the
symlink gotchas from `ARCHITECTURE.md` section 5 (Metro `watchFolders`,
`NODE_PATH`), but only in development. Consumers of tagged versions lose them
entirely.

## 9. Risks

| Risk | Why it matters | Containment |
|---|---|---|
| Slower feature work | Every engine feature so far (servers, folders, text) landed as one commit spanning engine, bindings and both apps. After extraction, each becomes a kit release plus a bump in the app | Extract only when a second consumer exists; use local overrides during development |
| Fork maintenance | Each upstream release means re-applying the patches, and the text patch reorders the first messages of `request` | Upstream the patches; keep Python-CLI interop in the kit's CI |
| Wire-compat obligations spread | Pairing vectors, the handshake format and directory-offer mode strings become promises to several apps | Conformance suite in the kit; `wormhole-mini` and the Python CLI as independent checks |
| Shared server | One outage takes down every app | Keep the server picker pattern in every app; document self-hosting (`docs/VPS-SETUP.md`) |
| Public-package support load | Issues and platform requests from strangers | Phase 4 is optional; git-tag consumption covers your own apps |

## 10. Alternatives

- **Keep a monorepo and add future apps under `packages/`.** This is the
  cheapest option, and the path deps already work. It is viable if every app
  is yours, uses the same license and the same toolchain. The costs: CI
  builds everything, and release tags get muddled. Phases 1-2 are still
  worth doing.
- **Separate repo, git-tag consumption only.** The recommended end state for
  a solo product family. You get versioning and isolation without registry
  overhead.
- **Full public release** (crates.io + npm). Most reach, most work, and it is
  gated on the fork and the license. There seems to be a real gap: a search
  turned up no maintained magic-wormhole binding for React Native or
  Electron.
- **Build new apps on another implementation** (wormhole-william in Go with
  gomobile, Python magic-wormhole, or stock magic-wormhole.rs). None of these
  gives you RN plus Electron bindings with directory and text offers, so
  this discards work rather than saving it.

## 11. Decisions that are yours

1. **License** for the extracted wrapper (6.1). This decides whether future
   closed-source apps are possible at all.
2. **Scope:** a file/text/folder transfer SDK only, or also generic wormhole
   primitives (custom app id, message channel, transit stream). The first is
   most of the value for the least API surface.
3. **Audience:** your own apps (git tags) or the public (registries plus
   support).
4. **Platforms** the next app needs, which decides whether the iOS work is
   in scope.
5. **Timing:** start phase 1 now, or wait for the second app. Phases 1-2 pay
   off inside PortalGems either way.
