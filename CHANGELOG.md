# Changelog

All notable changes to PortalGems are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.3] - 2026-07-13

New look. PortalGems has a new brand icon - a diamond gem inside a swirling
portal - now used everywhere the app shows its face.

### Changed

- **New app icon** on Android (launcher, adaptive, and Android 13+ themed-icon
  variants) and on desktop (window icon plus AppImage/deb/rpm, Windows .exe,
  and macOS .dmg icons).
- README: brand logo added, decorative emoji removed.

[1.2.3]: https://github.com/Yenis/portal-gems/releases/tag/v1.2.3

## [1.2.2] - 2026-07-13

Choose your server. Transfers now default to the reliable **PortalGems server**,
and when you want you can switch to the public community server (for interop
with other magic-wormhole clients) or your own self-hosted one.

### Added

- **Connection server picker** in Settings: Public, the **PortalGems server**,
  or a Custom self-hosted server (with fields for your own rendezvous and
  transit-relay URLs).
- **Secure (`wss://`) rendezvous support.** The engine now speaks TLS to the
  mailbox server (rustls + bundled roots), so hosted/self-hosted TLS servers
  work; previously only cleartext `ws://` did.
- **[docs/VPS-SETUP.md](docs/VPS-SETUP.md)** and a README section: run your own
  mailbox + transit relay on a VPS (systemd, TLS via Caddy, firewall, common
  pitfalls, verification).
- Engine, both binding layers, and both apps thread a `ServerConfig` through
  every send/receive/pair call. The magic-wormhole app id stays fixed, so any
  two clients (including the reference `wormhole` CLI) on the *same* server
  still interoperate.
- **32-bit device support:** the Android build now includes the `armeabi-v7a`
  ABI, so older phones can install (they previously failed with "app not
  supported").
- **Back navigation:** a back arrow in the header on every non-home screen (both
  apps), and on Android the hardware **Back** button / back gesture now goes
  back one page instead of leaving the app.
- On a send **connection error**, a **Change server** shortcut jumps straight to
  Settings and scrolls to the server picker.
- **First-visit server helper:** a dismissible card in Settings (reopenable via
  an info button) explaining the Public / PortalGems / self-hosted options, with
  the same explanation added as a "Choosing a server" section on the in-app "How
  it works" page.

### Changed

- When the rendezvous server is unreachable, the error is now plain-language
  and actionable ("switch servers or self-host"), in all six languages, instead
  of a raw exception string.
- **Clarified that PortalGems is not an offline / LAN-only tool** - a mailbox
  server always brokers the handshake, even for same-network transfers - in the
  README and the in-app "How it works" page (all six languages).

### Fixed

- Pairing no longer crashes: tapping **Show pairing code** threw
  "crypto.getRandomValues must be defined" because Hermes has no Web Crypto. The
  secure-random polyfill is now loaded at startup.

[1.2.2]: https://github.com/Yenis/portal-gems/releases/tag/v1.2.2

## [1.0.1] - 2026-07-12

Maintenance release. No user-facing changes; the app is functionally identical
to 1.0.0.

### Fixed

- Release pipeline now builds every platform (APK, AppImage, deb, rpm, Windows
  .exe, macOS .dmg) on native CI runners from a single tag push.

[1.0.1]: https://github.com/Yenis/portal-gems/releases/tag/v1.0.1

## [1.0.0] - 2026-07-12

First public release. Secure, direct device-to-device file transfer over the
[magic-wormhole](https://magic-wormhole.readthedocs.io/) protocol - no accounts,
no cloud, end-to-end encrypted, and interoperable with any magic-wormhole client.

### Added

- **Send and receive files** between any two magic-wormhole clients, in any
  direction, using a short one-time code.
- **Receive confirmation** - see the file name and size and accept or decline
  before any data flows.
- **Direct LAN transfers** - two devices on the same network transfer
  peer-to-peer at full speed; a public relay is used only as an encrypted
  fallback.
- **Device pairing** - scan a QR code once, then repeat transfers between your
  own devices need only a confirmation tap, with no backend involved.
- **Android share-sheet integration** - "Share -> PortalGems" from any app.
- **CLI interop** - works with the reference `wormhole` client on servers and
  laptops.
- **6 languages** - English, Deutsch, Bosanski, Russkij, Francais, Espanol.
- **5 gem themes** (Diamond, Sapphire, Emerald, Ruby, Amethyst), each in light
  and dark.
- **Built-in explainer** covering how it works and why it is safe.
- Platforms: **Android** (APK) and **desktop** (Linux AppImage, Windows
  portable .exe) built on a shared Rust engine.

[1.0.0]: https://github.com/Yenis/portal-gems/releases/tag/v1.0.0
