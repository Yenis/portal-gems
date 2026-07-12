# Changelog

All notable changes to PortalGems are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
