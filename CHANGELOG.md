# Changelog

All notable changes to PortalGems are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.1] - 2026-07-12

Choose your server. When the public community mailbox server goes down (which
it does, taking every client with it), you can now switch to your own
self-hosted server instead. The default remains the public server.

### Added

- **Connection server picker** in Settings: Public or a Custom self-hosted
  server, with fields for your own rendezvous and transit-relay URLs. (A
  first-party "PortalGems" option is wired up and appears once that server is
  deployed.)
- **[docs/VPS-SETUP.md](docs/VPS-SETUP.md)** and a README section: run your own
  mailbox + transit relay on a VPS (systemd, TLS via Caddy, verification).
- Engine, both binding layers, and both apps thread a `ServerConfig` through
  every send/receive/pair call. The magic-wormhole app id stays fixed, so any
  two clients (including the reference `wormhole` CLI) on the *same* server
  still interoperate.

### Changed

- When the rendezvous server is unreachable, the error is now plain-language
  and actionable ("switch servers or self-host"), in all six languages, instead
  of a raw exception string.

[1.1.1]: https://github.com/Yenis/portal-gems/releases/tag/v1.1.1

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
