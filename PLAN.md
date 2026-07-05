# Portal Gems — Project Plan

A cross-platform magic-wormhole file transfer app: Android and Electron
(Windows/macOS/Linux) — interoperable with each other and with any standard
`wormhole` CLI. (A web app was considered and dropped — see §5.)

**Working title:** Portal Gems
**Status:** Phase 0 complete — all gates passed (engine ↔ CLI; Android chain;
Electron via napi-rs, incl. laptop-app ↔ phone-app transfers). See README status,
docs/phase0-android-notes.md and docs/phase0-desktop-notes.md. Next: Phase 1.
**Last updated:** 2026-07-05

---

## 1. Goals

- Send and receive files between any two endpoints running a magic-wormhole client:
  Android ↔ Android, Android ↔ Electron, Electron ↔ CLI (e.g. a VPS), etc.
- Clean, simple, intuitive UI, shared across all platforms.
- An in-app explainer page: how magic-wormhole works and its security model,
  including the direct same-Wi-Fi (LAN) transfer behavior vs. relay fallback.
- Device pairing via QR code so paired devices exchange files with a confirmation
  tap only — the wormhole code is derived and entered automatically in the background.
- 6 languages: **English (default), German, Bosnian, Russian, French, Spanish**.
- 5 theme variants, each with light and dark mode (10 palettes total).
- No user accounts. No backend of our own. All state in local storage.
- Distribution: direct APK, F-Droid, Google Play, Electron installers.

### Non-goals

- **No web app.** Originally planned, dropped due to browser platform constraints —
  full rationale in §5.
- No background operation: transfers require the app to be open and in the foreground
  on both ends. A paired transfer to a device whose app is not open **fails after a
  timeout** with a clear "the other device is not open" message.
- No iOS for now (but the Rust/UniFFI architecture leaves the door open — Swift
  bindings come for free).
- No accounts, no cloud storage, no transfer history synced anywhere.

---

## 2. Feasibility summary

| Feature | Verdict | Notes |
|---|---|---|
| Wormhole on Android via React Native | ✅ Feasible | Native Rust library (magic-wormhole.rs), not the Python CLI. See §4. |
| Electron desktop app | ✅ Feasible | Same Rust crate via napi-rs Node addon. Full protocol incl. LAN-direct. |
| Web app | ❌ Dropped | Browser constraints would force degraded transfers and a hosted relay. See §5. |
| Interop with the `wormhole` CLI | ✅ Free | Same wire protocol, same public servers. Zero extra work. |
| Direct phone↔phone on same Wi-Fi | ✅ Built into the protocol | Transit tries direct TCP first, falls back to relay. |
| QR pairing without a backend | ✅ Feasible | Sender-specified codes derived from a shared secret. See §6. |
| 6 languages / 10 theme palettes | ✅ Trivial | i18next + theme token system. |
| F-Droid / Play / APK / installers / web | ✅ Feasible | F-Droid needs a from-source build recipe incl. the Rust NDK build — plan for it from day one. |

**"No backend" nuance (acknowledged):** magic-wormhole depends on two public,
community-run servers — the **mailbox (rendezvous) server** for the handshake and a
**transit relay** as fallback when a direct connection is impossible. We run neither,
they store nothing, and relayed data is end-to-end encrypted (the relay sees only
ciphertext). Settings will allow self-hosted server URLs.

---

## 3. Architecture

One protocol engine in Rust, two thin platform bindings, one shared TypeScript
UI/logic layer built with React Native primitives (rendered in Electron's
Chromium renderer via react-native-web).

### Monorepo layout

```
portal-gems/
├── packages/
│   ├── engine-api/       # TS interface: WormholeEngine (send, receive, events, cancel)
│   ├── core/             # Shared TS: app state, pairing logic, code derivation,
│   │                     #   i18n resources, theme tokens, settings
│   ├── ui/               # Shared React components (React Native primitives,
│   │                     #   rendered on web via react-native-web)
│   ├── app-mobile/       # React Native Android app
│   └── app-desktop/      # Electron shell (main process loads the Node addon;
│                         #   renderer uses packages/ui via react-native-web)
├── native/
│   ├── wormhole-core/    # Rust crate: wraps the magic-wormhole crate, UniFFI-annotated
│   ├── wormhole-android/ # cargo-ndk build → .so per ABI + uniffi-bindgen-react-native
│   │                     #   generated Turbo Module
│   └── wormhole-node/    # napi-rs addon for Electron
└── docs/
```

### The engine interface (`engine-api`)

Every platform implements the same TypeScript interface:

```ts
interface WormholeEngine {
  sendFile(path: FileRef, opts?: { code?: string }): TransferHandle; // returns code + events
  receiveFile(code: string, destDir: string): TransferHandle;
  cancel(handle: TransferHandle): void;
  // events: code-allocated, peer-connected, progress, done, error
}
```

---

## 4. The Rust engine and its bindings

The single biggest engineering item. **Phase 0 exists to de-risk exactly this.**

1. **`wormhole-core` crate** — wraps the `magic-wormhole` crate (magic-wormhole.rs)
   into an app-shaped async API: `send_file`, `send_file_with_code` (needed for
   pairing), `receive_file`, cancellation tokens, progress/state callbacks.
   Embeds a Tokio runtime (callers are not Rust-async). Pins default mailbox/relay
   URLs, overridable from settings.
2. **UniFFI** — proc-macro annotations on the crate generate C scaffolding plus
   idiomatic Kotlin bindings (Swift free for a future iOS port). Progress events
   cross the FFI as callback interfaces.
3. **Android build** — Rust targets `aarch64-linux-android`, `armv7-linux-androideabi`,
   `x86_64-linux-android`; built with `cargo-ndk`; `.so` per ABI in `jniLibs`.
4. **React Native bridge** — `uniffi-bindgen-react-native` generates a Turbo Module
   (JSI) from the same UniFFI definitions: Rust async fns ⇒ JS promises, callbacks
   ⇒ JS events. Fallback if it proves immature: hand-written Kotlin module over the
   UniFFI Kotlin bindings (more code, well-trodden).
5. **Electron** — thin `napi-rs` wrapper compiles the identical `wormhole-core` into
   a Node native addon (`.node`) loaded in the Electron main process; renderer talks
   to it over IPC. Full protocol including LAN-direct transit.
6. **Toolchain discipline** — Rust toolchain and all binding-generator versions pinned
   from day one; CI builds every artifact from source (F-Droid requirement, §9).

**Known risk:** `uniffi-bindgen-react-native` is the newest link in the chain.
Phase 0 proves the whole chain end-to-end before any product code is built on it.

---

## 5. Dropped: the web app

A browser version was originally planned and was dropped after feasibility analysis.
The decision is recorded here so it isn't re-litigated later. Reasons:

1. **Browsers cannot open raw TCP sockets.** Wormhole's rendezvous protocol is
   WebSocket (fine in-browser), but **transit — the actual file transfer — is raw
   TCP**. A browser client therefore can never do direct LAN transfers; every
   transfer would be forced through a relay, silently losing the app's flagship
   direct phone↔laptop behavior on that platform.
2. **Interop with normal peers would require special server infrastructure.**
   The public transit relay is TCP-only. For a browser tab to exchange files with
   the CLI or our native apps, someone must run a transit relay that accepts
   WebSocket on one side and bridges to TCP on the other (the model Least
   Authority's winden.app uses). That means hosting and operating a server
   component ourselves — against the project's no-backend principle.
3. **Engine uncertainty / double maintenance.** magic-wormhole.rs compiling to
   `wasm32` with WebSocket transit was unproven; the likely fallback was a second,
   Go-based engine (wormhole-william → WASM) maintained only for the web tier.
4. **Weaker security for pairing secrets.** Web storage (`localStorage`) offers
   nothing comparable to Android Keystore / OS keychain for the long-term pairing
   secret.

The architecture doesn't preclude revisiting this later (the `WormholeEngine`
interface is platform-agnostic), but it is out of scope for this project.

---

## 6. QR pairing (no backend)

**Mechanism.** Wormhole senders may specify their own code (CLI: `--code`;
magic-wormhole.rs supports the same). Codes are `nameplate-word-word`, and any
client may claim an arbitrary nameplate on the mailbox server.

**Pairing.** Device A shows a QR containing `{device name, 256-bit random secret,
format version}`. Device B scans it, both store the entry locally (Android Keystore /
OS keychain / localStorage). That is the entire "relationship" — nothing leaves
the devices.

**Paired transfer.**
1. Sender picks a file and taps "Send to <name>". Receiver taps "Receive from <name>"
   (or accepts an incoming confirmation prompt when it joins the mailbox).
2. Both sides independently derive the same one-time code:
   `HKDF(secret, time_bucket) → nameplate (large numeric) + two words` from the
   standard wordlist. Receiver also tries adjacent time buckets to tolerate clock
   drift and tap-timing skew.
3. Sender opens the wormhole with that code; receiver joins; user confirms; transfer
   proceeds exactly like a manual transfer (LAN-direct when possible).
4. **Timeout:** a wormhole sender would wait forever, so we cancel after ~45 s and
   show: *"<name> doesn't seem to have the app open."* No background operation.

**Security note.** Derived codes carry the full entropy of the 256-bit pairing secret —
strictly stronger than the default two-word (~16-bit) codes. The QR must be treated
like a password during the one moment it is displayed; devices can be renamed and
revoked (deleted) at any time from settings.

---

## 7. UI surface

- **Send** — file picker (SAF on Android) → shows the human-readable code + QR of the
  code → progress → done. Option: "send to paired device" list.
- **Receive** — code entry (with wordlist autocomplete, like the CLI) or "receive from
  paired device" → confirm file name/size → progress → saved location.
- **Paired devices** — list, add (show QR / scan QR), rename, revoke.
- **Explainer page** — localized, with simple diagrams:
  1. Codes & SPAKE2: how a short human code bootstraps a strong shared key,
     why a wrong guess fails safely, why codes are single-use.
  2. End-to-end encryption: servers and relays see only ciphertext.
  3. **Transit: direct same-Wi-Fi transfers** — devices on the same network connect
     directly, phone-to-phone; the relay is only a fallback.
  4. What the mailbox server and transit relay are, who runs them, what they can
     and cannot see.
  5. How pairing works and where the secret lives.
- **Settings** — language, theme (5 variants × light/dark, follow-system default),
  default save folder, server URLs (mailbox / transit relay), about/licenses.

**i18n:** i18next + react-i18next; JSON resource files in `packages/core`; device
locale detection with manual override. Languages: `en` (default), `de`, `bs`, `ru`,
`fr`, `es`. All strings externalized from the first commit.

**Themes:** design-token system (colors, spacing, radii, type) in `packages/core`;
5 named palettes × light/dark; ThemeProvider shared by all platforms.

---

## 8. Platform specifics

- **Android:** foreground service *while a transfer is running* (screen-off protection
  only — not background operation); SAF/scoped storage for pick & save; camera
  permission for QR scan (react-native-vision-camera); Keystore-backed storage for
  pairing secrets. Bare React Native (or Expo prebuild) — custom native modules rule
  out Expo Go.
- **Electron:** engine in main process, `contextIsolation` on, minimal preload IPC
  surface; native file dialogs; QR display always, QR scan via webcam where present
  (manual entry fallback); secrets in OS keychain (keytar/safeStorage).

---

## 9. Distribution

| Channel | Artifact | Notes |
|---|---|---|
| Direct APK | signed `.apk` on GitHub Releases | Simplest; also the F-Droid reproducibility reference. |
| F-Droid | built from source by F-Droid | 100% FOSS deps, zero Google/proprietary libs, pinned toolchains, build recipe covering RN **and** the Rust NDK build. Precedent exists for both; plan from day one. |
| Google Play | `.aab` | Target-SDK compliance; easy data-safety form (everything local). |
| Electron | AppImage/deb/rpm, dmg, nsis via electron-builder | macOS/Windows code signing decided later; Flathub optional later. |

License: **GPL-3.0-or-later** (decided 2026-07-04; `LICENSE` in repo root).
Compatible with the EUPL-1.2 `magic-wormhole` dependency via the EUPL's downstream
compatibility clause, and a first-class license on F-Droid.

---

## 10. Roadmap

**Phase 0 — De-risking spikes** *(go/no-go gates, in order)*
1. `wormhole-core` crate: send/receive against the real CLI from a desktop Rust test.
2. Android chain: UniFFI → cargo-ndk → uniffi-bindgen-react-native → minimal RN
   screen; transfer phone ↔ CLI both directions; phone ↔ phone direct on LAN and
   over mobile data via relay.
3. napi-rs addon in a bare Electron shell; laptop ↔ phone transfer.

**Phase 1 — Mobile MVP:** full send/receive UI, progress/cancel, foreground service,
SAF save handling, error states. Strings externalized, token-based styling (single
theme, English only — but wired for more).

**Phase 2 — Desktop:** Electron shell reusing `packages/ui` via react-native-web,
engine over IPC, file dialogs, parity with mobile flows.

**Phase 3 — Pairing:** QR generate/scan on both platforms, secret storage per
platform, code derivation in `packages/core` with cross-platform test vectors,
paired send/receive flow, 45 s timeout + "device not open" message, manage/revoke UI.

**Phase 4 — Polish:** explainer page (content + diagrams, all languages), 5×2 themes,
full translation pass (en, de, bs, ru, fr, es), settings, accessibility pass.

**Phase 5 — Ship:** hardening (network edges, huge files, storage-full, permission
denials), then: GitHub APK releases → F-Droid recipe + metadata (screenshots,
descriptions in all 6 languages) → Play listing → Electron installers → web deploy.

---

## 11. Risks & open questions

| Risk | Mitigation |
|---|---|
| `uniffi-bindgen-react-native` maturity | Phase 0 gate; fallback: hand-written Kotlin bridge over UniFFI Kotlin bindings. |
| F-Droid recipe complexity (RN + Rust NDK) | Pin toolchains from day one; keep a from-source build script in-repo and CI-verified. |
| Public server rate limits / etiquette | Configurable server URLs; be a good citizen; self-host option documented. |
| ~~License compatibility (EUPL dep)~~ | ✅ Resolved: app is GPL-3.0-or-later (EUPL→GPLv3 compatibility clause). |

**Open questions (non-blocking):**
- ~~Final app name~~ ✅ **PortalGems** (confirmed). Brand context: Gems-Tech;
  likely package ID `com.gemstech.portalgems` (locked in Phase 1).
- Which 5 theme palettes — proposal: **Sapphire, Emerald, Ruby, Amethyst, Diamond**
  (neutral default), tying into Gems-Tech branding; each in light + dark.
- Multi-file / folder send (protocol supports directories via zip) — MVP or later?
