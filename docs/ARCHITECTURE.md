# PortalGems - Architecture Reference

The single document to read before building new features. Everything here was
verified working as of 2026-07-11 (phases 0–4 complete). Per-phase discovery
notes live in the other `docs/*.md` files; this is the consolidated map.

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
                     public mailbox server + transit relay
                     (community-run; direct TCP when possible)
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
- `send_zip_as_folder(zip_path, dir_name, num_files, num_bytes, ...)` - sends
  an app-staged zip as a directory offer; the Android path (Kotlin zips the
  SAF tree, Rust can't read `content://`).
- `request_receive(code, cancel) -> PendingReceive { file_name, file_size,
  folder: Option<FolderOffer{dir_name, num_files, num_bytes}> }`
  - connects and waits for the offer WITHOUT accepting: powers confirmation
  UIs. For directory offers `file_name`/`file_size` describe the zip transfer
  (`<dirname>.zip`) and `folder` carries what the UI should show.
  `PendingReceive::accept(dest_dir, ...) -> PathBuf` (never clobbers:
  `name (1).ext` for files, `name (1)` for folders - folder names are never
  extension-split). For a folder offer, accept stages the zip inside
  `dest_dir`, unpacks it into a folder named after the offer, deletes the
  zip, and returns the folder path. Unpacking is zip-slip-safe
  (`enclosed_name`) and capped at `unpack_cap(num_bytes)` (claim + 25% +
  16 MiB) against zip bombs. `::reject()` unchanged.
- `receive_file(...)` = request + auto-accept (used by pairing handshake).
- `create_test_file(dir, size_kb)` - dev/test helper.
- File names from the network are sanitized (`sanitize_file_name` strips path
  components; empty/dot names → `received.bin`; folder names via
  `sanitize_dir_name` → `received`).
- Zip via the `zip` crate (deflate only, pure Rust through miniz_oxide - keeps
  the Android/F-Droid "no C deps" posture); blocking zip/unzip work runs on
  the `blocking` crate's thread pool.
- Errors: one flat `Error` enum (`InvalidCode`, `Cancelled`, `AlreadyConsumed`,
  wrapped wormhole/transfer/IO). Foreign sides receive the Display string;
  `packages/core/src/errors.ts::friendlyError` pattern-matches it to
  localized messages. If you add error cases, extend BOTH.
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
  Timeouts: sender 45 s, receiver poll 60 s. A frozen test vector pins the
  derivation - **changing it breaks pairing between app versions**. Own UTF-8
  codec (Hermes has no TextDecoder). Crypto via @noble/hashes (pure JS).
- `errors.ts` - engine-string → i18n-key mapping.

Tests: `cd packages/core && npm test` (vitest, 25 tests).

## 4. The apps

Both implement the same flows/routes: home (devices + send + receive), send
(paired or code), receive (request → confirm → accept), pair (show QR /
scan / paste), settings (language + theme, persisted), explainer.

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

### Mobile - `packages/app-mobile` (`com.gemstech.portalgems`)

- Kotlin support module `PortalGemsNative` (registered manually in
  MainApplication): SAF `copyToCache(uri)` (Rust can't read `content://`),
  MediaStore `saveToDownloads` (API 29+ insert + legacy fallback, dedup name
  queried back), foreground `TransferService` (dataSync, held only during
  transfers), `consumePendingShare` (ACTION_SEND intake, polled on mount +
  AppState active), EncryptedSharedPreferences pair store, zxing-embedded
  `scanQr()`, plain SharedPreferences `get/setSetting`, constants
  (`incomingDir`, `cacheDir`, `deviceName`, `locale`).
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
  falls back to debug key when absent). ABIs: arm64-v8a + x86_64 (add armv7
  before store release).

### Desktop - `packages/app-desktop`

- React DOM renderer (deliberate pivot from the react-native-web plan - shared
  *brains* in core, thin per-platform UIs), esbuild-bundled
  (`NODE_PATH=./node_modules` for the symlinked core's deps).
- Pairing storage: `safeStorage`-encrypted file in userData. Settings:
  localStorage. Device name: hostname.
- Receives into `~/Downloads` or the folder picked in Settings (localStorage
  `pg-download-dir`). `pg:acceptDownload` stages the transfer in
  `userData/incoming/<id>` and only then moves it into the destination
  (recreating a deleted folder with `mkdir -p`); overwrite replaces the
  existing file only after the transfer completed, keep-both applies the
  `name (n).ext` convention. `pg:statTarget` powers the pre-accept same-name
  warning; `pg:accept` (explicit dir, pairing handshake) is unchanged.
- Smoke harness (dev-only, env-guarded in main.ts): `PG_SMOKE_RECEIVE=<code>`,
  `PG_SMOKE_RECEIVE_CANCEL=<code>`, `PG_SMOKE_PAIR_SHOW=1`,
  `PG_SMOKE_PAIRED_RECEIVE=1`, `PG_SMOKE_PAIRED_SEND=<file>`,
  `PG_SMOKE_SEND_FOLDER=<dir>` + `PG_SMOKE_CODE=<code>` (folder send on a
  fixed code, bypassing the unscriptable picker dialog) - drives the real
  renderer via executeJavaScript; used for all E2E verification. The receive
  smoke handles file and folder offers (it waits on the shared "Do you want
  to receive this" prefix). Counterpart CLI harnesses:
  `cargo run --example send <path> [code]` sends a file OR folder
  (`--example recv` prints `OFFER-FOLDER:name:files:bytes`); both take
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

## 7. Verified-state summary & known gaps

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
to default. Note: the app's engine connect has no timeout - with Wi-Fi off it
hangs on "Connecting" until cancelled (pre-existing; candidate for a fix).

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
checksummed; bad-URL and unreachable-rendezvous error mappings confirmed). The
mobile side needs the ubrn regen + on-device wiring. The `PORTALGEMS_*`
server (be-my-guest.io) is deployed and live - it served all the 2026-07-19
folder E2E runs - and is the app's default choice; note the CLI examples and
the reference CLI default to the PUBLIC server, so cross-testing needs
explicit server flags on one side.

Gaps: QR *camera* scan untested (needs real phone) - NOTE: "Show pairing code"
currently crashes on device (react-native-svg suspected, unconfirmed);
mobile server-picker UI + ubrn regen; 32-bit `armeabi-v7a` ABI (older phones
get INSTALL_FAILED_NO_MATCHING_ABIS); paired-transfer UI buttons E2E (smoke
modes exist); mid-transfer cancel; share-sheet multi-file intake
(ACTION_SEND_MULTIPLE - the folder picker path now covers bulk sends);
F-Droid recipe; store metadata.
