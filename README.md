# PortalGems 💎

**Secure device-to-device file transfer, powered by the [magic-wormhole](https://magic-wormhole.readthedocs.io/) protocol.**

PortalGems lets you send files from one device to another with nothing but a short,
one-time code — no accounts, no cloud storage, no size limits imposed by a middleman.
It is being built for **Android** (React Native) and **desktop — Windows/macOS/Linux**
(Electron), and it interoperates with **any** magic-wormhole client, including the
original `wormhole` CLI on a server or laptop.

> **Status: early development.**
> The protocol engine works and is verified against the reference CLI
> (see [Project status](#project-status)). The mobile and desktop apps are not built yet.
> The full engineering plan lives in [PLAN.md](PLAN.md).

---

## Table of contents

- [Why PortalGems?](#why-portalgems)
- [How it works](#how-it-works)
- [Security model](#security-model)
- [Features](#features)
- [Device pairing (no backend)](#device-pairing-no-backend)
- [Architecture](#architecture)
- [Project status](#project-status)
- [Building from source](#building-from-source)
- [Trying the Phase 0 engine](#trying-the-phase-0-engine)
- [Roadmap](#roadmap)
- [Distribution](#distribution)
- [Languages & themes](#languages--themes)
- [License](#license)
- [Acknowledgments](#acknowledgments)

---

## Why PortalGems?

Sending a file between two of your own devices is still absurdly hard. Email
attachments have size limits, chat apps recompress your photos, cloud drives want
accounts and sync everything, and USB cables are never where you need them.

PortalGems takes a different approach, inherited from magic-wormhole:

- **One short code** (like `7-crossover-clockwork`) spoken, typed, or scanned once —
  that's the entire setup.
- **End-to-end encrypted, always.** The code bootstraps a strong shared key via a
  PAKE (password-authenticated key exchange). Nobody in the middle can read your file.
- **Direct when possible.** Two devices on the same Wi-Fi transfer directly,
  peer-to-peer, at LAN speed. A public relay is used only as a fallback — and it
  only ever sees ciphertext.
- **No accounts, no backend of ours, no stored data.** Everything lives on your
  devices.
- **Interoperable.** PortalGems speaks the standard magic-wormhole protocol, so you
  can send from your VPS with `wormhole send` and receive on your phone, or from
  your phone to a friend's laptop running any compatible client.

## How it works

A transfer involves three parties: the two devices, plus a lightweight public
**mailbox server** used only for the initial handshake.

```
 Sender                        Mailbox server                      Receiver
   │  1. allocate mailbox,          │                                 │
   │     get code ────────────────► │                                 │
   │                                │ ◄──────────── 2. join with code │
   │  3. PAKE handshake (SPAKE2) — both sides derive the same         │
   │     strong session key from the short code ───────────────────► │
   │                                                                  │
   │  4. exchange connection hints (encrypted) ─────────────────────► │
   │                                                                  │
   │  5. TRANSFER: direct TCP if reachable (same Wi-Fi/LAN),          │
   │     otherwise via a transit relay — encrypted either way         │
   ▼                                                                  ▼
```

1. The **sender** connects to the mailbox server and gets (or supplies) a code like
   `7-crossover-clockwork`. The number is a "nameplate" (a rendezvous slot); the words
   are a one-time password.
2. The **receiver** enters the same code and joins the same mailbox.
3. Both sides run **SPAKE2**, a password-authenticated key exchange: from the short
   code, they derive an identical, strong 256-bit session key. A wrong code — or an
   attacker guessing — causes the handshake to fail *safely*, and the code is burned.
4. Using that key, the devices exchange **encrypted connection hints** (their IP
   addresses on local networks, etc.).
5. The file flows over the best available path: a **direct TCP connection**
   (same Wi-Fi → phone-to-phone at LAN speed) or, if the devices can't reach each
   other, through a public **transit relay** that blindly forwards encrypted bytes.

The in-app **"How it works"** page explains all of this interactively, in all six
supported languages.

## Security model

- **Confidentiality:** every byte of the file (and of the metadata) is encrypted
  end-to-end with keys derived from the SPAKE2 handshake. The mailbox server and the
  transit relay see only ciphertext and cannot decrypt anything.
- **Active attackers:** the code is single-use and low-friction to verify out-of-band.
  An attacker who tries to intercept must guess the code *on the first try*; a failed
  guess is immediately visible to both users and invalidates the transfer.
- **Paired devices** (see below) use 256 bits of stored entropy instead of a
  two-word code, making online guessing effectively impossible.
- **No metadata trail:** no accounts, no server-side history, no telemetry. Pairing
  secrets are stored in the Android Keystore / OS keychain.
- **What we don't defend against:** an attacker with full control of *your unlocked
  device*, and traffic analysis (an observer can see *that* you transferred
  something and roughly how large it was, but not *what*).

## Features

| | |
|---|---|
| 📤 Send & receive files | Between any two magic-wormhole clients, any direction |
| 📡 Direct LAN transfers | Same Wi-Fi → peer-to-peer at full speed, no relay |
| 🔗 CLI interop | Works with `wormhole` on servers, laptops, anything |
| 💠 Device pairing | Scan a QR once; from then on, transfers need only a confirmation tap |
| 🌍 6 languages | English, Deutsch, Bosanski, Русский, Français, Español |
| 🎨 5 gem themes | Diamond, Sapphire, Emerald, Ruby, Amethyst — each in light & dark |
| 🔓 No accounts | No backend of ours, no cloud, everything stored locally |
| 📖 Built-in explainer | The full "how it works & why it's safe" story, in-app |

## Device pairing (no backend)

The wormhole protocol lets a sender *choose* the code instead of getting a random
one. PortalGems uses this to make repeat transfers between your own devices
effortless — with no server involved:

1. **Pair once:** device A shows a QR code containing a device name and a random
   256-bit secret; device B scans it. Both store the entry locally (Keystore/keychain).
2. **Transfer forever after:** when you tap *"Send to Phone"* / *"Receive from
   Laptop"*, both devices independently derive the same one-time wormhole code from
   the shared secret and the current time window — and connect automatically. You
   just confirm the incoming file.
3. **Both apps must be open.** There is no background service and no push server.
   If the other device isn't listening, the transfer times out (~45 s) with a clear
   message.

Paired devices can be renamed or revoked at any time. Losing a phone? Revoke it on
the other device and the stored secret becomes useless.

## Architecture

One protocol engine, written in Rust on top of
[magic-wormhole.rs](https://github.com/magic-wormhole/magic-wormhole.rs), shared by
every platform through thin bindings:

```
             ┌────────────────────────────────────────────┐
             │        packages/ui  (React Native)         │
             │   shared screens, themes, i18n, pairing    │
             └───────────────┬──────────────┬─────────────┘
                             │              │
                   app-mobile (Android)   app-desktop (Electron,
                             │            UI via react-native-web)
                             │              │
             uniffi-bindgen-react-native   napi-rs Node addon
                   (Kotlin/JSI)             │
                             │              │
             ┌───────────────┴──────────────┴─────────────┐
             │        native/wormhole-core (Rust)         │
             │  app-shaped API over magic-wormhole.rs:    │
             │  send / receive / custom codes / progress  │
             └────────────────────────────────────────────┘
```

A web app was considered and deliberately dropped: browsers can't open TCP
connections, which would have meant no direct LAN transfers and a mandatory
self-hosted relay bridge. The full rationale is recorded in
[PLAN.md §5](PLAN.md).

## Project status

- ✅ **Plan & feasibility analysis** — [PLAN.md](PLAN.md)
- ✅ **Phase 0, gate 1: protocol engine proven** (2026-07-04, all against the *real*
  public wormhole servers and the reference Python CLI):
  - `wormhole-core` **send** → CLI `wormhole receive`: ✔ checksum-identical
  - CLI `wormhole send` → `wormhole-core` **receive**: ✔ checksum-identical
  - **Sender-specified code** (the pairing mechanism) engine→engine: ✔
  - Direct (non-relay) transit confirmed in all three runs
- ✅ **Phase 0, gate 2: the engine runs on Android** (2026-07-05, React Native
  0.85 + UniFFI/uniffi-bindgen-react-native, tested on the Android 14 emulator):
  - App **send** → CLI `wormhole receive`: ✔ checksum-identical
  - CLI `wormhole send` (fixed/paired-style code) → app **receive**: ✔ checksum-identical
  - Direct (non-relay) transit in both directions; build workarounds documented
    in [docs/phase0-android-notes.md](docs/phase0-android-notes.md)
- ✅ **Phase 0, gate 3: the engine runs in Electron** (2026-07-05, napi-rs addon,
  Linux x64):
  - Electron ↔ CLI: ✔ both directions, checksum-identical
  - **Electron ↔ Android app: ✔ both directions** — the "laptop app to phone app"
    scenario, checksum-identical, direct transit
  - Finding: Electron's V8 memory cage rules out ubrn's `@ubjs/node` runtime, so
    desktop uses a small cage-safe napi-rs addon (`native/wormhole-node`);
    details in [docs/phase0-desktop-notes.md](docs/phase0-desktop-notes.md)
- 🎉 **Phase 0 complete — all de-risking gates passed.** One Rust engine, proven
  on Android, desktop, and against the reference CLI.
- 🟡 **Phase 1 nearly complete: the real Android app** (`packages/app-mobile`,
  `com.gemstech.portalgems`). Working end-to-end on the emulator (2026-07-06):
  system file picker **and share-sheet intake** ("Share → PortalGems") → send
  with code screen + copy; receive with **accept/decline confirmation showing
  file name and size** → file published to the public **Downloads** folder;
  friendly error messages; progress with direct/relay indicator; cancel;
  foreground service during transfers; Diamond theme (light/dark) from shared
  design tokens; every string externalized via i18next. Remaining: app icon/
  branding, release signing, mid-transfer cancel verification — see
  [docs/phase1-mobile-notes.md](docs/phase1-mobile-notes.md)
- ⬜ Phases 2–5: desktop app, pairing, polish, releases — see [Roadmap](#roadmap)

## Building from source

### Prerequisites

- [Rust](https://rustup.rs/) (stable; the project pins its version for reproducible
  F-Droid builds)
- Optionally, the reference CLI for interop testing:
  `pipx install magic-wormhole` (or your distro's `magic-wormhole` package)

### Build the engine

```bash
cd native/wormhole-core
cargo build --examples
```

### Build & run the desktop spike (Electron)

```bash
cd packages/app-desktop
npm install
npm run build          # bundles the app and builds the napi-rs addon
npx electron . --no-sandbox
```

### Build the Android spike

See [docs/phase0-android-notes.md](docs/phase0-android-notes.md) for the full
toolchain (Android SDK/NDK, cargo-ndk, uniffi-bindgen-react-native) and its
version-drift workarounds. Short version:

```bash
cd packages/wormhole-rn
yarn install
yarn ubrn:android      # cross-compiles Rust + regenerates bindings (see notes!)
cd example/android && ./gradlew installDebug
```

## Trying the Phase 0 engine

The crate ships two tiny example binaries used as the Phase 0 test harness.

**Send a file** (code is generated and printed):

```bash
cargo run --example send -- /path/to/file
# CODE:7-crossover-clockwork
# TRANSIT:Direct peer=192.168.1.23:41234
# PROGRESS:100
# SEND-OK
```

Receive it anywhere — on another machine, with the reference CLI:

```bash
wormhole receive 7-crossover-clockwork
```

**Receive a file** sent by any wormhole client:

```bash
cargo run --example recv -- 7-crossover-clockwork /tmp/downloads
```

**Simulate a paired transfer** (both sides pre-agree on the code, as paired devices
derive it automatically):

```bash
cargo run --example send -- /path/to/file 784413-some-derived-code   # device A
cargo run --example recv -- 784413-some-derived-code .               # device B
```

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 0 | De-risking spikes: Rust engine ↔ CLI, Android chain, Electron chain | ✅ complete |
| 1 | Android MVP: send/receive UI, progress, foreground service | 🟡 core flows working |
| 2 | Desktop app: Electron shell, shared UI, feature parity | ⬜ |
| 3 | QR pairing on both platforms | ⬜ |
| 4 | Polish: explainer page, 10 theme palettes, 6 languages, settings | ⬜ |
| 5 | Ship: hardening, F-Droid, Google Play, APK & installer releases | ⬜ |

## Distribution

Planned channels, once tested enough:

- **Android:** direct APK (GitHub Releases), [F-Droid](https://f-droid.org/), Google Play
- **Desktop:** AppImage / deb / rpm, macOS dmg, Windows installer

## Languages & themes

- **Languages:** English (default), Deutsch, Bosanski, Русский, Français, Español
- **Themes:** five gem palettes — 💎 Diamond (default), 🔷 Sapphire, 🟢 Emerald,
  ❤️ Ruby, 🟣 Amethyst — each in light and dark mode

## License

PortalGems is free software, licensed under the
**[GNU General Public License v3.0 or later](LICENSE)**.
It builds on [magic-wormhole.rs](https://github.com/magic-wormhole/magic-wormhole.rs)
(EUPL-1.2, combined and distributed under GPLv3 via the EUPL's compatibility clause).

## Acknowledgments

- [Brian Warner](https://github.com/warner) and the
  [magic-wormhole](https://github.com/magic-wormhole/magic-wormhole) project — the
  protocol, the reference implementation, and the public mailbox/relay infrastructure.
- The [magic-wormhole.rs](https://github.com/magic-wormhole/magic-wormhole.rs)
  maintainers — the Rust implementation at the heart of PortalGems.
- Please be kind to the public community servers: for heavy use, self-host — the app
  will let you configure your own server URLs.
