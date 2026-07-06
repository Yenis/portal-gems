# Phase 1 — Android app (PortalGems) notes

Status 2026-07-06: core flows + confirmation + share intake working end-to-end
on the emulator against the reference CLI, checksum-verified:

- **Send**: SAF file picker → copy to app cache (Kotlin) → engine send → code
  screen with copy button → progress with direct/relay indicator → success.
- **Receive with confirmation**: code entry (validated) → engine
  `requestReceive` (new `IncomingFile` object API) → **Accept/Decline screen
  showing file name + size** → accept streams into cache → published to public
  **Downloads** via MediaStore (deduped name queried back) → success screen.
  Decline calls `reject()`; the sender sees "transfer rejected".
- **Share-sheet intake**: PortalGems appears as an ACTION_SEND target; sharing
  from the Files app lands directly on the Send screen with the shared file.
  (JS polls `consumePendingShare` on mount + AppState active — no event
  emitters. Note: a share delivered while PortalGems is already the foreground
  activity is only picked up on the next AppState transition; unreachable via
  the real share sheet.)
- **Friendly errors** (`src/errors.ts`): unclaimed nameplate → "wrong code /
  sender gone" text, rejection, peer-gone and network patterns; raw message as
  fallback.
- Foreground service (`dataSync`) held only while a transfer runs.
- Cancel wired via ubrn's `AbortSignal` on both flows (mid-transfer abort still
  not explicitly exercised — TODO).

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

## Regenerating bindings

`yarn ubrn:android` / `yarn ubrn:android:release` now chain
`scripts/ubrn-postgen.sh`, which deletes the Kotlin-flavor files ubrn re-emits
and restores our `android/CMakeLists.txt` from git. After a bindings change,
also run `yarn prepare` (bob) in wormhole-rn — the app resolves the built
`lib/` output, not `src/` — and restart Metro with `--reset-cache` if it was
running while `lib/` was rebuilt.

## Known gaps (Phase 1 backlog)

- Cancel: verify mid-transfer abort semantics on both sides; sender "waiting"
  cancel works via AbortSignal but leaves the code claimed briefly.
- App icon/branding, splash, release signing, Play target-SDK checklist.
- Multi-file share (ACTION_SEND_MULTIPLE) is not handled; single file only.
