# PortalGems - Architecture Reference

The single document to read before building new features. Deferred work with
its reasoning lives in `docs/BACKLOG.md`; the Symbian client has its own map
in `docs/SYMBIAN.md`. This describes the
released 1.4.5 (2026-10-12); what was verified, and how, is in section 8.
Per-phase discovery notes live in the other `docs/*.md` files; this is the
consolidated map.

```
                    ┌───────────────────────────────────────────┐
                    │            packages/core (TS)             │
                    │ tokens · i18n(6 langs) · pairing · errors │
                    └────────┬──────────────────────┬───────────┘
                             │                      │
              packages/app-mobile            packages/app-desktop
              (React Native 0.85)            (Electron, React DOM)
                             │                      │
              packages/wormhole-rn           src/engine.ts (IPC in main)
              (ubrn turbo-module, JSI)              │
                             │               native/wormhole-node
                             │               (napi-rs, id registry)
                             └──────────┬───────────┘
                                        │
                          native/wormhole-core (Rust)
                        app-shaped API over magic-wormhole.rs
                                        │
                        mailbox server + transit relay
              (PortalGems, public or your own; direct TCP when possible)
```

## 1. The engine - `native/wormhole-core`

Rust crate over `magic-wormhole` 0.8.1 (EUPL-1.2; app is GPL-3.0-or-later via
the compatibility clause). The dependency is a **vendored copy** at
`native/magic-wormhole` (path dep) carrying a small local patch that exposes
protocol-v1 `directory` offers - the standard wormhole folder transfer the
released crate supports on the wire but hides. See
`native/magic-wormhole/PORTALGEMS-PATCH.md` for the exact diff and the
upgrade recipe; the patch is upstreamable. Wire format: the offer message is
`{"offer":{"directory":{dirname, mode:"zipfile/deflated", zipsize, numbytes,
numfiles}}}` followed by zip bytes - `mode` MUST be `"zipfile/deflated"` (the
only mode the Python reference accepts; upstream's own test fixture saying
"zipped" is wrong).

Public API (all take a `cancel` future that races
the ENTIRE pipeline - a waiting sender blocks inside `Wormhole::connect`, so
cancel must cover more than the transfer phase):

- `send_file(path, code: Option<&str>, on_code, on_transit, progress, cancel)`
  - `code: None` allocates a fresh 2-word code; `Some(code)` claims that exact
  code (`MailboxConnection::connect(..., allocate=true)`) - the pairing
  primitive.
- `send_folder(path, ...)` - zips the tree into a temp workspace (deflate,
  entries relative to the folder root, empty dirs kept, symlinks skipped,
  cancellable via an abort flag) and sends it as a directory offer.
- `send_files(paths, bundle_name, ...)` - several files and folders in one
  transfer. Zips the selection (each path a top-level entry, a folder as a
  tree, same-name items told apart as `name (1).ext`, compared without
  regard to case) and sends it as a directory offer carrying the loose
  marker `"portalgems":{"loose":true,"files":7,"folders":2}` - the counts
  are the top-level entries, what the receiver will see arrive, while
  `numfiles` still counts every file. For two or more items only: one file
  or one folder goes through `send_file`/`send_folder` so it reaches other
  clients as exactly that. Design: `docs/MULTI-FILE-DESIGN.md`.
- `send_zip_as_folder(zip_path, dir_name, num_files, num_bytes, loose, ...)`
  - sends an app-staged zip as a directory offer; the Android path (Kotlin
  zips the SAF tree, Rust can't read `content://`). `loose:
  Option<LooseBundle{files, folders}>` adds the marker.
- `request_receive(code, cancel) -> PendingReceive { file_name, file_size,
  folder: Option<FolderOffer{dir_name, num_files, num_bytes, loose}> }`
  - `loose` is set when the sender offered a selection, not one folder, and
  carries its top-level file and folder counts for the prompt.
  `accept` does the same either way and returns the unpacked directory; the
  app moves its children into the receive folder instead of the directory.
  - connects and waits for the offer WITHOUT accepting: powers confirmation
  UIs. For directory offers `file_name`/`file_size` describe the zip transfer
  (`<dirname>.zip`) and `folder` carries what the UI should show.
  `PendingReceive::accept(dest_dir, ...) -> PathBuf` (never clobbers:
  `name (1).ext` for files, `name (1)` for folders - folder names are never
  extension-split). For a folder offer, accept stages the zip inside
  `dest_dir`, unpacks it into a folder named after the offer, deletes the
  zip, and returns the folder path. Unpacking is zip-slip-safe
  (`enclosed_name`), capped at `unpack_cap(num_bytes)` (claim + 25% +
  16 MiB) against zip bombs, and at `entry_cap(num_files)` entries (twice
  the claim + 10,000) against an archive of empty files, which the byte
  cap cannot see and which is refused before anything is created.
  `wh_unpack_cap` and `wh_entry_cap` in `native/wormhole-mini` are the same
  two rules, with the same test tables. A transfer that does not complete leaves nothing
  staged: the partial file, and a half-unpacked folder, are removed by a
  `Drop` guard rather than on an error path, because cancellation arrives as
  a dropped future (the apps abort the UniFFI future) and never unwinds. That
  matters beyond tidiness - a leftover partial would push the next transfer
  of that name to `name (1).ext`. `::reject()` unchanged.
- `receive_file(...)` = request + auto-accept (used by pairing handshake).
- `create_test_file(dir, size_kb)` - dev/test helper.
- File names from the network are sanitized (`sanitize_file_name` strips path
  components; empty/dot names → `received.bin`; folder names via
  `sanitize_dir_name` → `received`).
- Zip via the `zip` crate (deflate only, pure Rust through miniz_oxide - keeps
  the Android/F-Droid "no C deps" posture); blocking zip/unzip work runs on
  the `blocking` crate's thread pool.
- Reaching the mailbox server is bounded by `CONNECT_TIMEOUT` (20 s):
  `open_mailbox` is the one place a send or a receive connects and claims,
  allocates or joins its code, and it fails with `Error::ConnectTimeout` if
  the server has not answered by then. The bound stops there on purpose.
  Everything after it - `Wormhole::connect`, where a sender waits for its
  receiver - can take as long as the other person does. The engine cannot
  tell an offline device from a silent server, so `errors.connectTimeout`
  names both, and `isServerUnreachableError` is true for it.
- A code holds two devices, and the server turns a third away with the
  error `crowded`. magic-wormhole reports that as "Error with the rendezvous
  server connection" - its words for a server it cannot reach - and keeps
  the server's own word in the error's source, which no binding carries. So
  `From<WormholeError>` picks that one case out as `Error::Crowded`, which
  `errors.ts` maps to `errors.codeUnusable` with no "Change server" shortcut.
  The string says only that the code can no longer be used: the usual third
  arrival is the user's own crashed or cancelled attempt, and naming "two
  devices" reads as a file that went to someone else.
- Errors: one flat `Error` enum (`InvalidCode`, `Cancelled`, `AlreadyConsumed`,
  `ConnectTimeout`, `Crowded`, wrapped wormhole/transfer/IO). Foreign sides receive the Display string;
  `packages/core/src/errors.ts::friendlyError` pattern-matches it to
  localized messages. If you add error cases, extend BOTH - and regenerate
  the Android binding, which decodes the enum by position: a variant it does
  not know arrives as `UnexpectedEnumCase`, and one added in the middle
  shifts the rest. For the TypeScript alone no cross-compile is needed: build
  the crate for the host, then from `native/wormhole-core` run `ubrn generate
  jsi bindings --library --ts-dir <tmp> --cpp-dir <tmp>
  target/debug/libwormhole_core.so`, format with wormhole-rn's prettier and
  copy `wormhole_core.ts` over. The C++ does not change for an error case.
- Wire-compatible with every magic-wormhole client (CLI, Warp, Destiny…) on the
  SAME servers. Every entry point takes a `ServerConfig { rendezvous_url,
  transit_url }` (uniffi Record / napi object); empty fields fall back to the
  community defaults. `app_config()` clones `APP_CONFIG` and overrides only the
  rendezvous URL - the app id stays fixed, so interop is preserved. Bad URLs
  surface as `Error::InvalidServerUrl` (mapped in `errors.ts`). The picker model
  + resolver live in `packages/core/src/servers.ts`; each app persists the
  choice (mobile `setSetting('pg-server')`, desktop localStorage `pg-server`)
  and passes the resolved config on every send/receive/pair call.
- **`wss://` (TLS) support is NOT default.** magic-wormhole's own `tls` feature
  maps to `async-tungstenite/async-tls`, which has no smol-runtime integration in
  0.34 and fails to compile; `native-tls` would drag in OpenSSL (painful for
  Android). So `Cargo.toml` instead enables rustls on the shared async-tungstenite
  (`async-tungstenite` with `futures-rustls-webpki-roots`) plus `rustls` with the
  `ring` provider, and `lib.rs::ensure_crypto_provider()` installs ring once at
  each entry point (rustls 0.23 panics without a provider). rustls+ring
  cross-compiles cleanly to all Android ABIs and trusts Let's Encrypt via bundled
  webpki roots. Without this, only cleartext `ws://` works and TLS servers fail
  with "rendezvous server connection". Verified E2E against a real `wss://` server
  (desktop + mobile, incl. transit-relay fallback).

Tests: `cargo test` (unit) · `cargo test -- --ignored` (network round-trip).

CI runs every suite that needs neither a network nor a device on each push
to master and each pull request (`.github/workflows/test.yml`): core, the
desktop's typecheck and tests, this crate's unit tests, and wormhole-mini on
the host and under qemu-arm. The `--ignored` round trips stay manual.

## 2. Binding layers

### Android - `packages/wormhole-rn` (uniffi-bindgen-react-native 0.31)

- `native/wormhole-core/src/ffi.rs` holds the UniFFI surface: async
  `send_file`/`send_folder`/`send_zip_as_folder`/`receive_file`/
  `request_receive`, object `IncomingFile` (`fileName()/fileSize()/
  folderOffer()/accept()/reject()`; `folderOffer()` returns the
  `FolderOfferInfo` record - `undefined` for plain files), callback trait
  `TransferListener { on_code, on_transit, on_progress }`.
- TS signatures generated in `src/generated/wormhole_core.ts`: u64 → `bigint`,
  async fns take `{ signal: AbortSignal }` (abort = drop the Rust future =
  cancellation; this is how mobile cancel works).
- **Pure C++ turbo-module** (RN ≥ 0.77 style): no Kotlin/Gradle in the library;
  the app builds `android/CMakeLists.txt` directly. ubrn re-emits its old
  Kotlin flavor on every `--and-generate` - `scripts/ubrn-postgen.sh` (chained
  in `yarn ubrn:android[:release]`) deletes it and restores our CMakeLists.
- After regenerating: `yarn prepare` (bob rebuilds `lib/`, which is what apps
  resolve) and restart Metro with `--reset-cache`.
- jniLibs (`.a` per ABI) are build outputs (gitignored); `android/generated`
  (RN codegen) IS committed (`codegenConfig.includesGeneratedCode: true`).

### Desktop - `native/wormhole-node` (napi-rs 2)

- Electron's V8 memory cage forbids external ArrayBuffers → ubrn's `@ubjs/node`
  is unusable here; this addon crosses the FFI with strings/f64 only.
- **Id-registry model** (avoids napi async-method-on-class lifetime issues):
  renderer allocates an id; `sendFile(id, …)`, `sendFolder(id, …)`,
  `requestReceive(id, code) → {fileName, fileSize, folder?: {dirName,
  numFiles, numBytes}}`, `acceptReceive(id, destDir)` (returns a folder path
  for directory offers), `rejectReceive(id)`, `cancelTransfer(id)` (tokio
  oneshot → engine cancel future).
- Loaded in the Electron **main** process (`src/engine.ts`); renderer talks
  via IPC (`pg:*` handlers in `src/main.ts`, exposed by `src/preload.ts`,
  events streamed on `pg:event {id, event, ...}`).

## 3. Shared logic - `packages/core`

Consumed by both apps as **npm `file:` symlinks** (see §5 build gotchas).

- `tokens.ts` - 5 gem themes (`THEME_NAMES`) × light/dark `Palette`, spacing/
  radius/fontSize scales. UI components take colors from the active palette
  only - never hardcode.
- `i18n/` - en/de/bs/ru/fr/es JSON + `initI18n(locale)`, `setLanguage`,
  `SUPPORTED_LANGUAGES`. **Every user-visible string goes in en.json first,
  then ALL five translations** - `vitest` fails if key sets or `{{placeholders}}`
  diverge (i18n.test.ts).
- `pairing.ts` - THE protocol-critical file. Payload
  `PGPAIR1:<b64url(json{v,name,secret})>` (32-byte secret); code derivation
  `HMAC-SHA256(secret, "portalgems-code-v1:"+bucket)` → 8-digit nameplate +
  2×10 hex; bucket = unixSeconds/300, receiver tries `[b, b−1, b+1]`.
  Each bucket holds `PAIRED_CODE_ATTEMPTS` (3) codes: attempt 0 hashes the
  label above unchanged, later attempts append `":"+attempt`. A sender only
  moves past attempt 0 after one of its own sends failed to finish, because
  the server keeps that send's claim on the nameplate until the bucket rolls
  over and a second claim on it makes the receiver a third, which the server
  rejects (`crowded`). Which attempt to use comes from an in-flight marker
  (`SEND_ATTEMPTS_KEY`, `nextSendAttempt`/`withSendStarted`/
  `withSendFinished`) written before a paired send and cleared only when one
  completes - so a crash, a cancel and a timeout all step the next send on.
  `candidateCodes()` is the receiver's side of that: every bucket × attempt,
  likeliest first. Attempt 0 staying byte-identical is what lets an updated
  device still meet one that knows nothing of attempts.
  `native/wormhole-mini` has the same three codes (`wh_pair_derive_attempt`,
  `wh_pair_next_attempt`); the phone keeps its marker in memory only - see
  "Pairing" in `docs/SYMBIAN.md`.
  - **The handshake is a message, not a file** (since 1.4.0). A file offer
    needs transit - a connection the two devices open to each other - and on
    first contact that is the step most likely to fail: a laptop and a phone
    typically cannot reach each other until something has opened the way, and
    `transit.rs` waits a full 60 s before saying so, which is also the whole
    pairing window. Both sides sat waiting, and only the user's second attempt
    worked, on the mappings the first one opened. `send_text` builds no relay
    hints and negotiates no transit, so the handshake is now one mailbox round
    trip and typically lands in under a second.
  - **Which form to send is negotiated, so no version is locked out.** The
    payload carries `hs: 'msg'` when the side that made it can read a message
    (`wantsMessageHandshake`), and the sender obeys it: message to a peer
    that asked for one, file to anything older. Receivers accept both.
    `native/wormhole-mini` implements the same negotiation -
    `wh_pair_payload.wants_message`, written by `wh_pair_encode` only when
    set and read back by `wh_pair_decode` - so Symbian pairs without transit
    against 1.4.0 and still sends a file to anything that did not ask.
    The field is written only when set, so a payload without it encodes to
    exactly the bytes earlier versions produced, and every parser - here and
    `wh_pair_decode` in `native/wormhole-mini` - looks up the keys it knows
    and ignores the rest. All four version combinations are exercised in
    core's tests and were checked against a live mailbox.
  Timeouts: sender 45 s, receiver poll 60 s, **each poll attempt 10 s**
  (`PAIRED_ATTEMPT_TIMEOUT_MS`). A frozen test vector pins the
  derivation - **changing it breaks pairing between app versions**. The
  literals are pinned in core's tests and in `native/wormhole-mini`'s
  `test_pair.c`, and were checked against an independent Python
  implementation; the old test compared `deriveCode` with itself and could
  never fail. Own UTF-8
  codec (Hermes has no TextDecoder). Crypto via @noble/hashes (pure JS).
  - **Names and renames.** A device sends the name it calls itself
    (`createPairingPayload`, and the handshake), and the other side stores it
    as `PairedDevice.name`. `label` on top of it is a local rename that never
    leaves the device: `deviceLabel(d)` - `label` if non-blank, else `name` -
    is what every screen shows, and clearing the label brings the original
    back, which is why the two are kept apart. Own name: desktop localStorage
    `pg-device-name` over `os.hostname()`, mobile setting `pg-device-name`
    over Android's, Symbian `device_name` in server.txt. All three run typed
    names through `sanitizeDeviceName` (no control characters, capped at
    `DEVICE_NAME_MAX_BYTES` = 60 **bytes** on a character boundary), because
    a name crosses the wire into fixed C buffers. Renaming later reaches
    nobody: the peer keeps the name it learned, and renames its own end.
  - **Most recently used first.** `PairedDevice.lastUsedAt` is set by each
    app's `markDeviceUsed` when a transfer with that device completes, in
    either direction (a received message counts at the offer, which is when
    it is complete). `loadDevices` returns the list through `sortByRecent`
    (`lastUsedAt`, else `addedAt`), so every list is in that order. The
    timestamp is stored for that and nothing else: it is never shown. A
    "Last transfer 5 min ago" line under each device was removed in
    1.4.3, because the app is to keep no visible record of transfers. Local
    only, like `label`. Symbian keeps `pairs.txt` itself in
    that order instead - see `docs/SYMBIAN.md`.
  - **Getting the payload across.** Three ways, one payload: a QR code,
    copy/paste, or *pairing over a code* - the displayer allocates an ordinary
    wormhole code and sends the encoded payload through it as a text message
    (`send_text`); the joiner types the code, gets the payload from
    `IncomingFile.text()`, and from there both sides run the unchanged
    handshake (joiner sends its name over the derived code, displayer polls for
    it). No new format and no new derivation, so existing pairings and the QR
    path are untouched. `classifyPairingInput` lets one field take either a
    typed code or a pasted payload. Desktop leads with the code (it has no
    camera); Android keeps its QR buttons first and offers the code below them
    for a peer without a camera. Mobile's `receivePairingInvitation` declines a
    file offered on the code, so its sender fails cleanly.
  - **Why each attempt is bounded.** A nameplate still claimed by a sender
    that died while waiting (killed, crashed, battery) makes a receiver join
    and then wait forever for a PAKE that never comes; the loop's own deadline
    is only checked *between* attempts, so one stale code stalled paired
    receive indefinitely. Found while testing pairing: the harness's
    timed-out senders left exactly such claims. Reproduced on purpose (one
    SIGKILLed sender on `b+1`) and shown abandoned at 10001 ms before the real
    offer was found. An abandoned attempt leaves our own claim, so the stale
    nameplate reports "crowded" and fails fast from then on. Mobile does the
    same through `withAttemptBound`, an AbortController per attempt that
    follows the outer signal.
- `errors.ts` - engine-string → i18n-key mapping.

Tests: `cd packages/core && npm test` (vitest, 169 tests).

## 4. The apps

Both implement the same flows/routes: home (devices + send + receive), send
(paired or code), receive (request → confirm → accept), pair (show QR /
scan / paste), settings (language + theme, persisted), explainer, user guide.

Folder flows (both apps): home has a "send folder" button next to the file
one; the send route carries a `SendItem` union (`kind: 'file' | 'folder'`).
Desktop picks via `pg:pickFolder` (openDirectory dialog + a JS tree walk for
the count/size preview) and sends through `pg:sendFolder`; mobile picks via
`pickSendFolder`, shows a "Preparing folder…" phase while `zipTreeToCache`
runs, then calls `sendZipAsFolder` (the staged zip is deleted afterwards in
all outcomes). Receive confirm shows "folder name · N files · size" from the
offer metadata; the conflict prompt has folder-specific strings and warns
that overwrite replaces the whole folder. Desktop `pg:acceptDownload` moves
the unpacked directory (rename, EXDEV falls back to `fs.cp` recursive) and
clears an overwritten target with `rm -rf` only after the transfer
completed; `pg:statTarget` counts any occupant and returns `isFolder` +
recursive size.

Several files in one transfer (all three apps; the reasoning and the
alternatives that were turned down are in `docs/MULTI-FILE-DESIGN.md`):

- **On the wire** it is a directory offer with one extra member,
  `"portalgems":{"loose":true,"files":7,"folders":2}`. A client that does
  not know it saves a folder called `dirname` - which is why `dirname` is a
  readable name (`bundleName`: "7 files and 2 folders - 2026-10-11 14.32").
  `files`/`folders` count top-level entries, what will appear in the receive
  folder; `numfiles` keeps its standard meaning. The offer string is pinned
  byte for byte in two places that must agree: `test_offer_directory_loose`
  (vendored crate) and `tests/test_bundle.c` (wormhole-mini).
- **What is sent** is decided by `planSend` in core: one file is a `file`
  offer and one folder an unmarked `directory` offer, exactly as before;
  two or more items are a bundle. Never bundle a single item - other
  clients must keep receiving a lone photo as a photo.
- **Building the bundle**: desktop hands paths to the engine's `send_files`
  (`zip_items_sync`); Android zips `content://` URIs itself
  (`zipUrisToCache`) and calls `sendZipAsFolder` with the counts. Either
  way each item is a top-level entry and same-name items are told apart
  as `name (1).ext`, compared without regard to case - `unique_entry_name`
  in Rust, `bundleEntryNames` in core for the Android path.
- **Receiving**: the engine's `accept` is unchanged and returns the unpacked
  directory; each app then moves its top-level children into the receive
  folder - `landBundle` (desktop), `landEntries` + the per-item save calls
  (Android), `LandBundle` (Symbian, out of a `.stage` folder). No conflict
  prompt, never overwrite, never merge: a taken name becomes `name (1).ext`.
  The one exception is Android without a chosen download folder, where
  MediaStore merges a same-name folder (it has no directory objects).
- **The numbering rule lives in four places** and each has the same test
  table: `create_unique`/`unique_entry_name` (Rust), `dedupPath` (desktop),
  `wh_numbered_name` (C), `numberedFileName` (core). Change one, change all.
- **All or nothing** means the transfer: nothing reaches the receive folder
  until the archive is down and unpacked in staging. The move out of
  staging is item by item, so a disk that fills during it leaves some
  behind; every app then reports "N of M" (`savedBundleText`) instead of
  success or failure.
- **Words**: `itemsText` composes "7 files and 2 folders" and every bundle
  sentence takes it whole (`bundleText`). No plural engine is involved: the
  two nouns have a form for exactly one, and Russian and Bosnian word the
  general form so the noun never follows the number.
- Symbian receives bundles and does not send them.

### Mobile - `packages/app-mobile` (`com.gemstech.portalgems`)

- Kotlin support module `PortalGemsNative` (registered manually in
  MainApplication): SAF `copyToCache(uri)` (Rust can't read `content://`),
  MediaStore `saveToDownloads` (API 29+ insert + legacy fallback, dedup name
  queried back), foreground `TransferService` (dataSync, held only during
  transfers), `consumePendingShare` (ACTION_SEND and ACTION_SEND_MULTIPLE intake,
  polled on mount + AppState active: returns every shared file's URI and
  reported name; `itemFromUris` makes one file a file and several a bundle,
  and with paired devices `App.tsx` routes it through `ShareTargetScreen` to
  choose one of them or a one-time code), EncryptedSharedPreferences pair store, zxing-embedded
  `scanQr()`, plain SharedPreferences `get/setSetting`,
  `zipUrisToCache(uris, names)` (several picked or shared files into one
  archive for a multi-file send, each read once straight from its URI; the
  entry names are decided in JavaScript by `bundleEntryNames`),
  `listStaged(path)` / `removeStaged(path)` (the top-level items of an
  unpacked multi-file bundle, and the recursive cleanup of what is left of
  it - cache paths only),
  `clearIncomingDir()` (empties `cache/incoming`, called once at bundle load:
  the engine's own cleanup cannot run when Android kills the process), and
  constants (`incomingDir`, `cacheDir`, `deviceName`, `locale`).
- Folder support (all heavy methods run on their own `Thread`):
  `pickSendFolder` (ACTION_OPEN_DOCUMENT_TREE, read-only grant, request code
  49376), `zipTreeToCache(uri)` (walks the DocumentFile tree once, streams it
  into `cache/outgoing/<name>.zip`, returns `{path, name, fileCount,
  totalBytes}` - the stats the engine puts in the directory offer),
  `saveFolderToDownloads` (Q+: one MediaStore insert per file with
  `RELATIVE_PATH Download/<folder>/<subdirs>` - MediaStore has no directory
  objects, so empty subfolders drop and same-named folders merge with
  per-file dedupe; pre-Q: recursive copy with top-level `name (n)` dedupe),
  `saveFolderToDownloadDir` (SAF tree: recursive createDirectory/createFile,
  keep-both `name (n)`, overwrite deletes the existing tree only after the
  transfer completed, deleted-tree fallback to Downloads with
  `fallback: true`). `statDownloadTarget` is folder-aware: any occupant of
  the name counts, `isFolder` flag, folder size = recursive walk.
- Receive path: engine → app cache → publish. Default target is MediaStore
  Downloads (`saveToDownloads`); if the user picked a download folder in
  Settings (SAF `ACTION_OPEN_DOCUMENT_TREE`, persisted grant; settings
  `pg-download-dir` + `pg-download-dir-label`), `saveToDownloadDir` writes into
  that tree instead. Because the source is staged in cache, an overwrite only
  touches the existing file after the transfer completed. Same-name conflicts
  are detected pre-accept via `statDownloadTarget` (custom folder only -
  MediaStore can't see other apps' files, the system de-dupes there). A
  deleted/revoked tree CANNOT be recreated (no grant on its parent): the save
  falls back to Downloads and the UI shows a notice (`fallback: true`).
- Release signing: `android/keystore.properties` + keystore (gitignored;
  falls back to debug key when absent). ABIs: arm64-v8a, armeabi-v7a and
  x86_64 (`reactNativeArchitectures` in `android/gradle.properties`, matching
  the targets in `packages/wormhole-rn/ubrn.config.yaml`).

### Desktop - `packages/app-desktop`

- React DOM renderer (deliberate pivot from the react-native-web plan - shared
  *brains* in core, thin per-platform UIs), esbuild-bundled
  (`NODE_PATH=./node_modules` for the symlinked core's deps).
- Pairing storage: `safeStorage`-encrypted file in userData. Settings:
  localStorage. Device name: `pg-device-name`, else the hostname.
- **Profile isolation (read before touching userData).** `app.getName()` is
  `portalgems-desktop` for dev, smoke *and* the packaged app - electron-builder
  writes no `productName` into the app's package.json, so all three resolved to
  `~/.config/portalgems-desktop`. A smoke run that persisted a scratchpad
  `pg-download-dir` therefore became the **installed** app's download folder,
  and the shipped 1.2.5 AppImage (no temp-path guard) really did save received
  files into a temp directory. `main.ts` now repoints `userData` when
  `!app.isPackaged`: smoke runs (any `PG_SMOKE_*` var) get
  `$PG_SMOKE_PROFILE` or `<tmpdir>/portalgems-smoke`, plain dev runs get
  `<appData>/portalgems-desktop-dev`. Packaged builds keep the default path, so
  no existing user's settings or pairings move. The smoke profile is stable, not
  per-run: `PG_SMOKE_PAIRED_RECEIVE`/`_SEND` reuse a pairing made by an earlier
  `PG_SMOKE_PAIR_SHOW` run.
- **Pairing smoke flows** - two instances, each with its own
  `PG_SMOKE_PROFILE`: `PG_SMOKE_PAIR_HOST=1` (prints `PAIR-CODE:<code>`) with
  `PG_SMOKE_PAIR_JOIN=<code>` pairs over a code; `PG_SMOKE_PAIR_SHOW=1`
  (prints `PAIR-PAYLOAD:...`) with `PG_SMOKE_PAIR_JOIN=<payload>` pairs by
  paste through the same field. `PG_SMOKE_DUMP_PAIRCODE=1` prints each stored
  pairing's derived code and its full poll candidate list (bucket × attempt,
  in polling order) - two paired profiles must print the same, which checks
  the secret without logging it.
  `PG_SMOKE_TRACE=1` logs every `requestReceive` (server, nameplate, outcome,
  duration); it is how the stale-claim stall above was found. Note the paired
  send smoke uses `PG_SMOKE_RENDEZVOUS`/`_TRANSIT` while the renderer uses its
  own setting (default: PortalGems server) - point both at the same server.
- Receives into `~/Downloads` or the folder picked in Settings (localStorage
  `pg-download-dir`). `pg:acceptDownload` stages the transfer in
  `userData/incoming/<id>` and only then moves it into the destination
  (recreating a deleted folder with `mkdir -p`); overwrite replaces the
  existing file only after the transfer completed, keep-both applies the
  `name (n).ext` convention. It resolves to `{ name, dir, fallback }` - `dir`
  is where the file *actually* landed and `fallback` is set when the chosen
  folder was not used, so the success screen reports the real destination
  instead of the requested one (see the temp-path guard below). A chosen
  folder that cannot be created - deleted, or on a drive no longer mounted -
  also falls back to Downloads rather than failing an already-completed
  transfer. `pg:statTarget` powers the pre-accept same-name warning;
  `pg:accept` (explicit dir, pairing handshake) is unchanged.
- User guide: `Guide` (desktop) and `GuideScreen` (mobile) render the
  `guide.*` strings as titled cards, the same shape as the explainer. The
  section list is per app because two entries are platform-specific: `share`
  on the phone, `drop` on the desktop. Symbian's equivalent is `KHelpText`
  behind Options > Help.
- Sending several at once: `pg:pickFiles` (the open dialog with
  `multiSelections`) and `pg:statDropped` (any number of dropped paths) both
  return `describeSelection(paths)` from `src/selection.ts` - a `file`, a
  `folder`, or a `bundle` with its paths, top-level counts and totals;
  `planSend` in core makes the call, so one item is never bundled. A bundle
  goes out through `pg:sendFiles` -> `engine.sendFiles`, named by
  `bundleName` in the sender's language. Symlinks are left out of a
  multi-item selection because the engine leaves them out of the archive.
  The paired-send timeout is armed on the `code` event, not at start: a
  folder or bundle is zipped before there is a code, and that time is ours.
  Smoke: `PG_SMOKE_SEND_FILES=<paths joined like PATH>` with `PG_SMOKE_CODE`.
- Receiving a loose bundle: `pg:requestReceive` notes the id when the offer
  carries `folder.loose`, and `pg:acceptDownload` then calls `landBundle`
  (`src/landing.ts`) instead of moving one entry: each top-level child of
  the unpacked directory goes into the download folder under its own name,
  `dedupPath` keeping both on a clash, never overwriting. It returns
  `bundle: {files, folders, expected}`, counted on disk, and the renderer
  words it with `savedBundleText`. `landing.ts` has no Electron in it so
  that `npm test` (esbuild, then `node --test`) can run it.
- Drag and drop: a file or folder dropped on a paired device's row sends it
  there. `preload.ts` `dropped(file)` resolves the path with
  `webUtils.getPathForFile` (a renderer no longer sees `File.path`) and
  `pg:statDropped` returns it in the pickers' shape; `App` refuses every other
  drop on the window, which would otherwise navigate to the file.
- The send picker remembers its last-used folder: the renderer persists the
  parent dir of a picked file/folder in localStorage `pg-last-send-dir`
  (`sendlocation.ts`) and passes it to `pg:pickFile`/`pg:pickFolder`, which set
  the dialog's `defaultPath` (via `pickerDefault`, which only passes it when it
  is still an existing directory - a stale path falls back to the OS default).
  Mobile gets this natively from the SAF document picker, so it needs nothing.
- A stored `pg-download-dir` that resolves under the OS temp dir
  (`os.tmpdir()`/`app.getPath('temp')`/`/tmp`) is treated as unset: files land
  in the real Downloads folder instead. Such a value only ever comes from an
  automated run that persisted a scratchpad path into the profile - it is never
  a legitimate user choice and would vanish on reboot. `isValidDownloadDir` in
  main enforces this for `resolveDownloadDir`; the exported `pg:downloadDirValid`
  IPC lets the renderer self-heal at startup (App-mount effect clears an invalid
  stored value, so Settings and the receive screen show the default). The guard
  does NOT touch a legitimate deleted folder under `$HOME` - that is still
  recreated with `mkdir -p`. Because the guard redirects silently, the receive
  success screen must render the `dir` that `pg:acceptDownload` returns, never
  the stored setting, and show `receive.folderFallback` when `fallback` is set
  - mirroring mobile's `usedFallback`. Rendering the stored value instead is
  how a redirected save came to *claim* it had gone to a scratchpad folder.
- Smoke harness (dev-only, env-guarded in main.ts): `PG_SMOKE_RECEIVE=<code>`,
  `PG_SMOKE_RECEIVE_CANCEL=<code>`, `PG_SMOKE_PAIR_SHOW=1`,
  `PG_SMOKE_PAIRED_RECEIVE=1`, `PG_SMOKE_PAIRED_SEND=<file>`,
  `PG_SMOKE_SEND_FOLDER=<dir>` + `PG_SMOKE_CODE=<code>` (folder send on a
  fixed code, bypassing the unscriptable picker dialog), `PG_SMOKE_DUMP_DLDIR=1`
  (logs `SMOKE:DLDIR=<value>` after the startup download-dir self-heal, for
  verifying stale-setting cleanup), `PG_SMOKE_PICK_DEFAULTPATH=<dir>` +
  `PG_SMOKE_PICK_FILE=<file>` (stubs the native file dialog to log
  `SMOKE:PICK-DEFAULTPATH=` / `SMOKE:REMEMBERED=`, verifying the send picker
  remembers its last dir) - drives the real
  renderer via executeJavaScript; used for all E2E verification. The receive
  smoke echoes the success screen's destination line as `SMOKE:SAVED=<text>`,
  so a run can assert where the file was reported to land - a temp
  `PG_SMOKE_DL_DIR` is rejected by the guard and must report the Downloads
  fallback, not the requested folder. The receive
  smoke handles file and folder offers (it waits on the shared "Do you want
  to receive this" prefix). Counterpart CLI harnesses:
  `cargo run --example send <path> [code]` sends a file OR folder, and
  `send --files <bundle name> <path> <path>...` a loose bundle (code from
  `PG_CODE`); `--example recv` prints `OFFER-FOLDER:name:files:bytes` and,
  for a bundle, `OFFER-LOOSE:files:folders`. Both take
  `PG_RENDEZVOUS_URL`/`PG_TRANSIT_URL` - remember the app defaults to the
  PortalGems server, so point the examples there or they meet nothing. Receive
  add-ons: `PG_SMOKE_DL_DIR=<dir>` (seed the download-folder setting; cleared
  when unset - the profile persists) and `PG_SMOKE_CONFLICT=overwrite|keepboth`
  (expect the same-name warning and resolve it). Isolate from the real profile
  with `XDG_CONFIG_HOME=<tmp>` (copy `user-dirs.dirs` in, else `getPath('downloads')`
  degrades to `$HOME`); note the smoke's `Receive` click hits a paired-device
  row first if the profile has devices.
- Run: `npm run build && npx electron . --no-sandbox`
  (**unset ELECTRON_RUN_AS_NODE** - VS Code shells export it).

### Notifications (both apps)

A transfer that finishes or fails while the app is not in front raises a
system notification; one that the user cancelled does not, and nothing is
shown while the app is being looked at - the screen already says it. Four
titles (`notify.*`: received, sent, receive failed, send failed) over the
file or folder name, `itemsText` for a bundle, "Message" for a text, or the
`friendlyError` text. Deliberately bare:

- **No actions, and a tap only brings the app forward.** Nothing in a
  notification opens a received file - decided against, so that a file is
  never opened by accident. There is no "open" or "show in folder" on the
  success screens either, for the same reason.
- **A message's words stay out of it.** A notification is read over a
  shoulder or on a lock screen.
- **It can be switched off**: Settings > Notifications, stored as
  `pg-notifications` = `'0'` on both platforms (absent means on).

Desktop: `renderer/notifications.ts` holds the setting and `notify()`;
`pg:notify` in `main.ts` shows an Electron `Notification` only when the
window is not focused, keeps it referenced until it closes (a collected one
loses its click handler), and sets the AppUserModelID on Windows, which
shows nothing without one. `PG_SMOKE_NOTIFY=1` logs each call as
`SMOKE:NOTIFY=<title>|<body>` whether or not it was shown.

Android: `src/notify.ts` checks `AppState` and the setting, then calls
`notifyFinished` in the Kotlin module, which posts on its own channel
("Finished transfers", so it can be silenced apart from the foreground
service's "File transfers") and does nothing, quietly, without the
notification permission - the one `withTransferService` already asks for.
The JavaScript is still running at that point because the foreground service
is what kept the transfer alive.

### About and licenses (all three apps)

GPLv3 asks that whoever receives the app is shown the license and where the
source is, and the components it bundles have notices of their own. So:

- `About` (desktop) and `AboutScreen` (Android), reached from the Help &
  settings card, show the installed version (`pg:version` ->
  `app.getVersion()`; `appVersion` from the package manager, not a number
  copied into the JavaScript), the GPL notice, `SOURCE_URL`, a line on
  privacy, and the component list for that platform. The address is text
  to copy, not a link - the desktop window never navigates. Symbian has an
  ABOUT paragraph at the end of `KHelpText`.
- The list is `COMPONENTS` in `packages/core/src/about.ts`, read from
  `licenses.json`, which is **generated** by `node scripts/gen-licenses.mjs`
  from what is installed and locked: npm packages walked from each app's
  `dependencies`, Rust crates from `cargo metadata` (normal dependencies
  only), plus a short table in the script for what no package manager
  reports - Electron and Chromium, the Android libraries Gradle pulls in,
  and the code vendored into the Symbian client. The same run writes
  `THIRD-PARTY-LICENSES.txt` at the repository root: the lists, then every
  distinct license text with the components it came with. The desktop
  installers carry that file and `LICENSE` in their resources folder
  (`extraResources`).
- **Run the script after changing a dependency and before a release**, and
  commit both files. Nothing checks that they are current.
- The strings are `about.*` in all six languages; license names and texts
  stay in English.

### Branding / icons

- Canonical logo: `assets/logo.png` (450px, opaque black background);
  `assets/brand-sheet.png` is the full brand exploration sheet;
  `assets/banner.png` (998x172, README header) has the six gem portals with a
  transparent background outside each circle so it works on GitHub light and
  dark themes. All app icons are generated from the logo - regenerate at these
  sizes if it changes:
- Android: legacy `mipmap-*/ic_launcher{,_round}.png` (48dp base,
  circle-masked), adaptive foreground rasters
  `mipmap-*/ic_launcher_foreground.png` (108dp base, logo at 70% so the ring
  stays inside the 66dp safe zone), background `#000000` in
  `values/colors.xml`, themed-icon vector
  `drawable/ic_launcher_monochrome.xml`.
- Desktop: `packages/app-desktop/build/icon.png` (512px) - electron-builder
  auto-derives all platform formats; also the BrowserWindow icon in `main.ts`.

### The third app - Symbian

`packages/app-symbian` is an Avkon application over `native/wormhole-mini`, a
second implementation of the wormhole protocol in freestanding C89. It shares
nothing with this tree: no `packages/core`, no Rust engine, no bindings - the
only thing in common is the wire format, which is the whole point of keeping
it. Adding a protocol feature means implementing it twice, and the two
implementations checking each other is what has caught the subtle bugs.

If you are touching the protocol, read `docs/SYMBIAN.md` before assuming a
change is confined to the Rust engine. Its tests run with no Symbian SDK
(`cd native/wormhole-mini && make test && make test-arm`), so there is no
excuse for letting it drift.

## 5. Build gotchas (cost hours; read before touching builds)

1. npm `file:` symlinks: Metro needs `watchFolders` + `nodeModulesPaths` +
   `blockList` (wormhole-rn's own react copies!); tsc needs `paths` entries;
   esbuild needs NODE_PATH. New core deps must be installed into BOTH apps.
2. ubrn regeneration re-emits Kotlin-flavor files → always via
   `yarn ubrn:android[:release]` (postgen script), never raw `--and-generate`.
3. @noble/hashes v2 requires `.js` suffixes in subpath imports.
4. Emulator/adb: `adb shell input text` mangles >~20 chars (chunk it);
   MediaStore ownership resets on reinstall; debug↔release signature clash
   needs uninstall.
5. `cargo new` creates nested git repos - check `git status` shows FILES, not
   a bare directory name, after adding a crate.
6. F-Droid discipline: no Google/proprietary deps anywhere (zxing-embedded and
   androidx are fine); toolchains pinned; everything builds from source.
7. **Duplicate-instance bug**: packages/core has its own node_modules (for
   vitest). If a bundler resolves i18next/react-i18next from there, the app
   gets a second instance and every string renders as its raw key. Guards:
   esbuild `--alias:i18next/react-i18next` (desktop build script), metro
   blockList on `core/node_modules` (mobile). Keep both when touching builds.
8. Packaging: **Linux builds locally** - `npm run dist:linux` → AppImage +
   `.deb` + `.rpm` (the `.rpm` target needs the `rpm` tool). **Windows (.exe)
   and macOS (.dmg) are built in CI on native runners**
   (`.github/workflows/release.yml`), NOT cross-compiled: napi-build's
   GNU-Windows path demands a `libnode.dll` you can't get on Linux, so the old
   `dist:win`/mingw route is a dead end (build on the target OS, or let CI do
   it). Desktop bundling is `build:bundles` (esbuild) - it uses `cross-env` for
   `NODE_PATH` so it runs on Windows runners too; each job copies the per-OS
   native addon into `dist/` before electron-builder. `asarUnpack: **/*.node`;
   engine.ts prefers `wormhole_node-<platform>-<arch>.node`, falls back to
   `wormhole_node.node`. The pipeline (create-release → linux/android/desktop
   matrix, each uploading binaries + `.sha256`) fires on any `v*` tag;
   `scripts/package-release.sh` collects local Linux/Android artifacts for
   manual uploads. Android CI needs `cargo-ndk` + the three rustup Android
   targets (arm64, **armv7**, x86_64 - `release.yml` installs them) + keystore
   secrets (`ANDROID_KEYSTORE_BASE64` etc.).
9. **Stale Metro bundle on incremental Android builds**: `assembleRelease`
   tracks the app's own JS but NOT edits inside the symlinked `@portalgems/core`
   source, so a change there (e.g. a constant in `servers.ts`) can be silently
   left out of the packaged Hermes bundle - the app runs old core code. CI is
   safe (clean checkout); locally, delete `app/build/generated/assets/react` +
   `app/build/intermediates/{assets,merged_assets}/release` before reassembling,
   and verify with `strings <apk>/assets/index.android.bundle | grep <token>`.

## 6. Feature recipes

- **New UI string** → en.json + 5 translations (tests enforce) → use via `t()`.
- **New engine capability** → wormhole-core generic fn (+cancel param) →
  ffi.rs uniffi export → `yarn ubrn:android` + `yarn prepare` →
  wormhole-node napi fn → engine.ts/main.ts/preload.ts IPC → both UIs.
- **New setting** → mobile `get/setSetting` + desktop localStorage; add to
  both settings screens. (Example: the download-location picker -
  `pg-download-dir` on both platforms.)
- **New screen** → Route union + screen component per app; strings in core.

## 7. Security review (2026-10-11, after 1.4.3; fixes released in 1.4.4)

A read of all three clients for input that crosses a trust boundary: the
network, another app on the phone, the renderer, the environment. What it
found and what was done, so the reasoning is not lost:

- **Android: a shared file's name was trusted** (the serious one).
  `copyToCache` joined the display name a content provider reports to the
  cache directory as it stood. A provider is another app, so
  `../../shared_prefs/x.xml` let any app that shares a file into PortalGems
  write a file anywhere in its private storage - at intake, before the user
  chose anything. The name is now reduced to a name (`safeLeafName`) and the
  destination checked to be directly inside the staging directory. Several
  files were never affected: `bundleEntryNames` already did this.
- **Android: only `content://` is read for sending** (`sendableUri`, and the
  filter in `MainActivity.captureShare`). A `file://` URI is opened with the
  app's own access, so a share could name the app's private files and have
  the user send them on; a provider belonging to the app itself is refused
  for the same reason.
- **Symbian: a frame length wrapped on a 32-bit long** (`ws.c`). The
  WebSocket length is 64-bit on the wire; `header + length` wrapped to a
  small number, after which a ping was echoed from four gigabytes past the
  receive buffer - memory, keys included, sent to the server - and a
  continuation frame was copied past the caller's buffer. The phone talks
  cleartext to the server, so anyone on the path could send either. Two
  checks in `test_proto.c` pin it; they passed on the 64-bit host and
  crashed under qemu-arm before the fix, which is what `make test-arm` is
  for.
- **Desktop: the pairing store was readable by other accounts.**
  `paired-devices.bin` was written with default permissions, and its
  encryption is not always real: no keyring means none, and Electron's
  `basic_text` fallback on Linux uses a fixed key. It is now mode 0600.
- **Desktop: the handshake file left the profile.** It was written to and
  accepted into the system temp directory under a fixed name. It now lives
  in `userData/handshake` (0700), and `pg:writeTemp`, `pg:readText`,
  `pg:deleteFile` and `pg:accept` are confined to that directory instead of
  taking any path the renderer names.
- **Desktop: the smoke harness and `PG_ADDON_PATH` worked in packaged
  builds.** `PG_SMOKE_RECEIVE=<code>` made the installed app receive and
  accept a transfer by itself, and `PG_ADDON_PATH` made it load a native
  library of the caller's choosing. Both need control of the app's
  environment, which is most of the way to running code already, but
  neither had any business in a release: the variables are now dropped when
  `app.isPackaged`.
- **Desktop: the window cannot navigate.** `will-navigate` is cancelled and
  `setWindowOpenHandler` denies, on top of the CSP (`default-src 'self'`,
  no inline script) and the explicit `sandbox`/`nodeIntegration` settings.
- **Both apps: the pairing handshake file is checked before it is taken.**
  It is the one transfer accepted without asking, and nothing limited it:
  whoever held the pairing secret could have any file, or a folder, written
  unprompted. `isHandshakeOffer` in core refuses folders and anything over
  `PAIRING_HANDSHAKE_MAX_BYTES` (4096).
- **Engine: names from the network are made storable on Windows**
  (`windows_safe_name`, applied under `cfg!(windows)` only): a `:` would
  name a hidden NTFS stream inside another file, a trailing dot changes the
  extension silently, and `CON`/`NUL`/`COM1` are devices.
- **Dependencies.** Electron 38 was past its support window and had a
  use-after-free fixed in 39.8.1: now 44. `rustls` 0.23.41 -> 0.23.45
  (handshake messages accepted at the wrong encryption level) and
  `event-listener` 5.4.1 -> 5.4.2, in both Cargo.lock files. Checked with
  `npm audit` and the OSV database for all 330 crates.

Added afterwards: a cap on the number of entries in a received archive
(`entry_cap`, above), which the review had left open. Its test also turned
up an overflow in the byte cap: `allowed + 1` on a cap of `u64::MAX`, which
an offer claiming an absurd size could reach, read nothing at all in a
release build and panicked in a debug one. It saturates now.

Looked at and found sound: zip unpacking in both engines (traversal
refused, size capped against the offer), received file and folder names,
the C client's JSON, transit and zip readers, the Android manifest (one
exported activity, no backup, cleartext off in release), the renderer (no
`innerHTML`, React escapes peer-supplied names and messages), and the
pairing derivation. What is left open - three hardening items, parked on
2026-10-12 - is in `docs/BACKLOG.md` under "Left from the security review".

## 8. Verified-state summary & known gaps

Verified E2E over real servers: manual send/receive (all platform pairs,
checksummed), receive confirmation + decline, share-sheet intake, friendly
errors, cancel (waiting phase, both engines), pairing (desktop↔emulator),
settings (language/theme live-switch, persisted), 6-language completeness.

Download location + same-name handling (2026-07-14) verified E2E against the
live PortalGems server on BOTH platforms. Desktop (smoke harness): custom
folder, deleted-folder recreation, overwrite (content replaced only after
completion), keep-both (`name (1).ext`), default-Downloads regression.
Android (Pixel 6a, release APK, adb-driven UI): SAF picker + persisted grant,
receive into the chosen tree, conflict prompt with existing-file size,
overwrite, keep-both, deleted-tree fallback to Downloads with notice, reset
to default. That run also found the engine's connect had no timeout - with
Wi-Fi off it hung on "Connecting" until cancelled. `CONNECT_TIMEOUT` (section
1) is the fix; it is covered by a unit test against a server that never
answers and has not been re-run on a device yet.

Packaging is done: all six binaries (APK, AppImage, deb, rpm, Windows .exe,
macOS .dmg) build and publish from a single `v*` tag via CI (first shipped in
v1.0.0/v1.0.1).

Folder transfer (2026-07-19) - the engine sends/receives protocol-v1
directory offers via the vendored magic-wormhole patch. Verified: engine unit
tests (zip round-trip incl. empty dirs, symlink skip, zip-slip rejection,
size-cap enforcement, folder-name dedupe) plus an ignored network folder
round-trip; **interop with the Python reference CLI in BOTH directions** over
the public server (Python's zip drops empty dirs, ours keeps them); desktop
E2E over the live PortalGems server via the smoke harness (folder confirm UI
with count/size, receive into custom download dir, keep-both → `name (1)`,
overwrite replacing the old tree only after completion, desktop folder send →
Python CLI unpack, single-file regression). **Android on-device (Pixel 6a,
release APK, adb-driven UI, live PortalGems server)**: receive folder (confirm
UI "name · N files · size", MediaStore publish into `Download/<folder>/` with
subdirs, checksums matched) from both the Rust example sender AND the Python
`wormhole send <dir>` CLI (real cross-client interop); send folder (SAF tree
picker → `zipTreeToCache` counted 3 files/24.5 KB → `sendZipAsFolder` →
laptop receiver, checksums matched incl. nested `sub/`).

Server picker (rendezvous + transit override) verified E2E on the desktop
engine against a locally-run mailbox + transit relay (64 KiB round-trip
checksummed; bad-URL and unreachable-rendezvous error mappings confirmed).
Android has the same picker in Settings and passes the resolved config on
every call. The `PORTALGEMS_*`
server (be-my-guest.io) is deployed and live - it served all the 2026-07-19
folder E2E runs - and is the app's default choice; note the CLI examples and
the reference CLI default to the PUBLIC server, so cross-testing needs
explicit server flags on one side.

Gaps, each with its reasoning in `docs/BACKLOG.md`: a sender that does not
finish never releases its nameplate; a connection lost while
waiting goes unnoticed. Not yet
verified end to end: QR *camera* scan (needs a real phone), cancel in the
middle of a transfer, and the paired-transfer buttons in the UI (smoke modes
exist). Not started: F-Droid recipe, store metadata.
