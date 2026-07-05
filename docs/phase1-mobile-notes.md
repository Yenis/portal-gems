# Phase 1 — Android app (PortalGems) notes

Status 2026-07-05: core flows working end-to-end on the emulator against the
reference CLI, checksum-verified:

- **Send**: SAF file picker → copy to app cache (Kotlin) → engine send → code
  screen with copy button → progress with direct/relay indicator → success.
- **Receive**: code entry (validated) → engine receive into cache → published
  to the public **Downloads** collection via MediaStore → success screen with
  final file name. POST_NOTIFICATIONS runtime prompt on first transfer.
- Foreground service (`dataSync`) held only while a transfer runs.
- Cancel wired via ubrn's `AbortSignal` on both flows (engine-side abort
  behavior not yet exercised in a real mid-transfer test — TODO).

## Structure

- `packages/app-mobile` — RN 0.85 app, applicationId `com.gemstech.portalgems`,
  standalone npm project. Engine and shared logic come in as **npm `file:`
  symlinks**: `wormhole-rn` and `@portalgems/core`.
- `packages/core` — shared TS: Diamond light/dark palette tokens (Sapphire/
  Emerald/Ruby/Amethyst later) + i18next setup with `en.json`. **All UI strings
  live here** — no literals in components.
- Kotlin support (`android/.../PortalGemsNativeModule.kt`, `TransferService.kt`,
  registered manually in `MainApplication.kt`):
  - `copyToCache(contentUri)` — SAF → real path for Rust; returns name/size.
  - `saveToDownloads(path, name)` — MediaStore on API 29+, legacy dir + rename
    loop below; deletes the cache copy.
  - `startTransferService`/`stopTransferService` + `incomingDir` constant.

## Symlinked-packages pattern (metro + tsc)

`metro.config.js`: `watchFolders` for `../wormhole-rn` and `../core`;
`nodeModulesPaths`/`extraNodeModules` pin react, react-native, i18next,
react-i18next to the app's copies; `blockList` excludes wormhole-rn's own
`node_modules/react{,-native}` and its `example/` (duplicate React = crash).
`tsconfig.json`: `paths` for i18next/react-i18next/react so the symlinked
packages typecheck.

ABIs restricted to `arm64-v8a,x86_64` in `gradle.properties` (match
wormhole-rn's jniLibs; extend before release).

## Known gaps (Phase 1 backlog)

- Receive offer confirmation (accept/reject with name+size) needs an engine API
  split (`request` vs `accept`) — currently receive starts immediately.
- Engine error strings are terse ("transfer failed"); map common cases
  (unclaimed nameplate = wrong code, timeout, network down) to friendly text.
- Cancel: verify mid-transfer abort semantics on both sides; sender "waiting"
  cancel works via AbortSignal but leaves the code claimed briefly.
- App icon/branding, splash, release signing, Play target-SDK checklist.
- Send-to-app via Android share sheet (ACTION_SEND intent) — natural addition.
