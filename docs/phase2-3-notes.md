# Phase 2 (desktop) & Phase 3 (pairing) - implementation notes

Landmark 2026-07-06. Both phases functionally complete and verified on
emulator + Linux desktop against the reference CLI and each other.

## Phase 2 - desktop app (packages/app-desktop)

- Real UI in **React DOM** (not react-native-web - deliberate pivot, see
  ARCHITECTURE notes when written; shared brains live in @portalgems/core:
  tokens, i18n, pairing, error mapping). Renderer bundled by esbuild
  (`NODE_PATH=./node_modules` needed for the symlinked core's deps).
- Same flows as mobile: send (native file dialog), receive with
  **accept/decline confirmation**, progress + direct/relay, cancel, friendly
  errors, dark/light via `prefers-color-scheme`. Saves to `~/Downloads`.
- Engine: `native/wormhole-node` napi addon rewritten to an **id-registry
  model** (sendFile/requestReceive/acceptReceive/rejectReceive keyed by a
  renderer-allocated id + `cancelTransfer(id)`) - avoids napi async-method
  lifetime issues. Events stream `main → renderer` on `pg:event`.
- **Engine cancellation** (wormhole-core): cancel future now races the whole
  pipeline - a waiting sender blocks inside `Wormhole::connect` (PAKE needs a
  peer), so transfer-phase-only cancel didn't fire. Verified: cancel of a
  waiting sender rejects with "the transfer was cancelled" in ~1s.
- Dev smoke harness in main.ts (env-guarded): PG_SMOKE_RECEIVE,
  PG_SMOKE_RECEIVE_CANCEL, PG_SMOKE_PAIR_SHOW, PG_SMOKE_PAIRED_RECEIVE,
  PG_SMOKE_PAIRED_SEND - drives the real renderer via executeJavaScript.
  Verified: UI receive flow end-to-end (checksum-identical), pairing.

## Phase 3 - pairing (no backend)

Protocol (all in `packages/core/src/pairing.ts`, shared verbatim by both apps;
@noble/hashes for HMAC-SHA256):

- Pairing payload `PGPAIR1:<base64url(json{v,name,secret})>` carries a random
  **32-byte secret** + the displayer's device name. Shown as QR + copyable
  string (manual paste works everywhere; QR scan on Android via
  zxing-android-embedded - F-Droid-safe, no Play Services).
- **Handshake**: scanner sends a tiny `pg-pair-handshake.json` (its device
  name) over the derived code; displayer polls candidate codes, receives it,
  and both sides persist a `PairedDevice`. 60s timeouts both sides.
- **Code derivation**: `HMAC-SHA256(secret, "portalgems-code-v1:" + bucket)` →
  8-digit nameplate + 2×10 hex chars; bucket = unix/300s; receiver tries
  buckets [b, b-1, b+1] in a poll loop (unclaimed nameplate = "not yet").
- **Paired transfers**: sender derives current-bucket code and waits max 45s →
  "device not open" message; receiver polls for 60s → "nothing arrived".
  Receive still shows the accept/decline confirmation.
- Storage: Android **EncryptedSharedPreferences** (Keystore-backed); desktop
  **Electron safeStorage** (OS keychain) in userData/paired-devices.bin.
- Devices UI: list on Home with Send/Receive per device, remove via
  long-press (mobile) / Remove button (desktop), Pair screen with show/scan/
  paste modes.

**E2E verified** (desktop ↔ emulator): full pairing over the real mailbox
server - desktop displayed, phone pasted, handshake transferred, both stored
("SMOKE:PAIRED-OK"). The handshake itself exercises the paired-transfer path
(derived code, sender+receiver poll).

## Known gaps / notes for the test phase

- **QR scanning on a real phone is untested** (emulator has no scannable
  camera); the scan path is ~20 lines over zxing-embedded. Manual paste is the
  verified fallback.
- Paired transfer via the full UI (device-row Send/Receive buttons) not yet
  exercised end-to-end - the underlying mechanism (derived codes both sides)
  is what the pairing handshake already proved. Covered by smoke modes
  PG_SMOKE_PAIRED_SEND / PG_SMOKE_PAIRED_RECEIVE for later verification.
- Mid-transfer (data-phase) cancel still unexercised; waiting-phase cancel
  verified on both engine paths.
- adb `input text` mangles >~20-char strings - type in chunks (test infra).
- Time-bucket derivation means paired devices need clocks within ±5 min.
