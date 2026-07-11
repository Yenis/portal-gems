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

Rust crate over `magic-wormhole` 0.8 (EUPL-1.2; app is GPL-3.0-or-later via
the compatibility clause). Public API (all take a `cancel` future that races
the ENTIRE pipeline - a waiting sender blocks inside `Wormhole::connect`, so
cancel must cover more than the transfer phase):

- `send_file(path, code: Option<&str>, on_code, on_transit, progress, cancel)`
  - `code: None` allocates a fresh 2-word code; `Some(code)` claims that exact
  code (`MailboxConnection::connect(..., allocate=true)`) - the pairing
  primitive.
- `request_receive(code, cancel) -> PendingReceive { file_name, file_size }`
  - connects and waits for the offer WITHOUT accepting: powers confirmation
  UIs. `PendingReceive::accept(dest_dir, ...) -> PathBuf` (never clobbers:
  `name (1).ext` suffixes) / `::reject()`.
- `receive_file(...)` = request + auto-accept (used by pairing handshake).
- `create_test_file(dir, size_kb)` - dev/test helper.
- File names from the network are sanitized (`sanitize_file_name` strips path
  components; empty/dot names → `received.bin`).
- Errors: one flat `Error` enum (`InvalidCode`, `Cancelled`, `AlreadyConsumed`,
  wrapped wormhole/transfer/IO). Foreign sides receive the Display string;
  `packages/core/src/errors.ts::friendlyError` pattern-matches it to
  localized messages. If you add error cases, extend BOTH.
- Wire-compatible with every magic-wormhole client (CLI, Warp, Destiny…);
  servers are the community defaults hardcoded in `default_relay_hints()` /
  `APP_CONFIG` (configurable server URLs = known backlog).

Tests: `cargo test` (unit) · `cargo test -- --ignored` (network round-trip).

## 2. Binding layers

### Android - `packages/wormhole-rn` (uniffi-bindgen-react-native 0.31)

- `native/wormhole-core/src/ffi.rs` holds the UniFFI surface: async
  `send_file`/`receive_file`/`request_receive`, object `IncomingFile`
  (`fileName()/fileSize()/accept()/reject()`), callback trait
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
  renderer allocates an id; `sendFile(id, …)`, `requestReceive(id, code) →
  {fileName, fileSize}`, `acceptReceive(id, destDir)`, `rejectReceive(id)`,
  `cancelTransfer(id)` (tokio oneshot → engine cancel future).
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

### Mobile - `packages/app-mobile` (`com.gemstech.portalgems`)

- Kotlin support module `PortalGemsNative` (registered manually in
  MainApplication): SAF `copyToCache(uri)` (Rust can't read `content://`),
  MediaStore `saveToDownloads` (API 29+ insert + legacy fallback, dedup name
  queried back), foreground `TransferService` (dataSync, held only during
  transfers), `consumePendingShare` (ACTION_SEND intake, polled on mount +
  AppState active), EncryptedSharedPreferences pair store, zxing-embedded
  `scanQr()`, plain SharedPreferences `get/setSetting`, constants
  (`incomingDir`, `cacheDir`, `deviceName`, `locale`).
- Receive path: engine → app cache → MediaStore publish → visible in Downloads.
- Release signing: `android/keystore.properties` + keystore (gitignored;
  falls back to debug key when absent). ABIs: arm64-v8a + x86_64 (add armv7
  before store release).

### Desktop - `packages/app-desktop`

- React DOM renderer (deliberate pivot from the react-native-web plan - shared
  *brains* in core, thin per-platform UIs), esbuild-bundled
  (`NODE_PATH=./node_modules` for the symlinked core's deps).
- Pairing storage: `safeStorage`-encrypted file in userData. Settings:
  localStorage. Device name: hostname. Receives into `~/Downloads`.
- Smoke harness (dev-only, env-guarded in main.ts): `PG_SMOKE_RECEIVE=<code>`,
  `PG_SMOKE_RECEIVE_CANCEL=<code>`, `PG_SMOKE_PAIR_SHOW=1`,
  `PG_SMOKE_PAIRED_RECEIVE=1`, `PG_SMOKE_PAIRED_SEND=<file>` - drives the real
  renderer via executeJavaScript; used for all E2E verification.
- Run: `npm run build && npx electron . --no-sandbox`
  (**unset ELECTRON_RUN_AS_NODE** - VS Code shells export it).

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
8. Packaging (electron-builder): `npm run dist:linux` → AppImage;
   `npm run dist:win` → portable .exe (needs `mingw-w64` +
   `rustup target add x86_64-pc-windows-gnu` for the addon cross-build;
   wine present for rcedit). `asarUnpack: **/*.node`; engine.ts prefers
   `wormhole_node-<platform>-<arch>.node`, falls back to `wormhole_node.node`.

## 6. Feature recipes

- **New UI string** → en.json + 5 translations (tests enforce) → use via `t()`.
- **New engine capability** → wormhole-core generic fn (+cancel param) →
  ffi.rs uniffi export → `yarn ubrn:android` + `yarn prepare` →
  wormhole-node napi fn → engine.ts/main.ts/preload.ts IPC → both UIs.
- **New setting** → mobile `get/setSetting` + desktop localStorage; add to
  both settings screens.
- **New screen** → Route union + screen component per app; strings in core.

## 7. Verified-state summary & known gaps

Verified E2E over real servers: manual send/receive (all platform pairs,
checksummed), receive confirmation + decline, share-sheet intake, friendly
errors, cancel (waiting phase, both engines), pairing (desktop↔emulator),
settings (language/theme live-switch, persisted), 6-language completeness.

Gaps: QR *camera* scan untested (needs real phone); paired-transfer UI buttons
E2E (smoke modes exist); mid-transfer cancel; server-URL setting; multi-file
share; electron-builder packaging; F-Droid recipe; store metadata.
