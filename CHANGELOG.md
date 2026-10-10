# Changelog

All notable changes to PortalGems are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] - 2026-10-09

Pairing, finally dependable.

### Changed

- **Pairing no longer needs the two devices to reach each other.** This is
  the fix for a bug worth describing, because it was the worst kind: pairing a
  computer with a phone for the first time left both sides waiting on
  "Waiting for the other device" until they gave up - and then worked on the
  second try, every time.

  The reason: the last step of pairing, where each device learns the other's
  name, was sent as a file. A file travels over a connection the two devices
  open directly to each other, and the first time two devices meet that
  connection is the thing most likely to fail - a laptop and a phone usually
  cannot reach each other until something opens the way. Your second attempt
  worked because the first one had opened it.

  That step is now a message, which travels through the same meeting point
  that carried the code - no connection between the devices required. Pairing
  two devices that have never met is now one round trip, and typically
  finishes in well under a second.

  Pairing with a device still on 1.3.x keeps working, and so does pairing
  with PortalGems Mini on Symbian. The pairing code a device shows now says
  which form it can read, so the other device sends the one it understands -
  the new way between two updated devices, the old way with anything else.
  Devices already paired are unaffected: existing pairings keep working and
  nothing needs setting up again.

### Fixed

- **A pairing that fails now says so, instead of leaving both devices
  waiting.** When the two sides do lose each other, both say what happened
  rather than sitting until a timeout, and they move on to a fresh code
  together instead of waiting on one that can no longer work. A phone no
  longer cuts a pairing short while the connection is still being made, and a
  connection that cannot be made is now named as that rather than reported as
  a mysterious failure.

- A device that disappeared at the wrong moment could crash the engine's
  worker thread instead of reporting an error.

[1.4.0]: https://github.com/Yenis/portal-gems/releases/tag/v1.4.0

## [1.3.5] - 2026-10-08

Paired devices, without the detours.

PortalGems Mini (Symbian) 0.10.0 catches up on the same ground: a paired
device can be sent a folder or a message as well as a file, a finished
pairing offers the first transfer and a rename, the paired menus list the
device used last first, and Options > Help says what every menu does.

### Added

- **Send a folder or a message to a paired device.** Until now a paired
  device only took a single file; folders and messages needed a one-time
  code. Open a device's row on the desktop or Android and both are there. On
  Symbian, choosing a device under Send to paired device now asks: File,
  Folder or Message.

- **Share to a paired device on Android.** "Share -> PortalGems" from the
  gallery or a file manager used to go straight to a one-time code. With
  paired devices it now asks where to send: one of them, or a code.

- **Drag and drop on the desktop.** Drop a file or a folder on a paired
  device to send it there.

- **A pairing that ends somewhere useful.** "Paired!" is now followed by the
  two things people do next: give the device a name of your own, and try a
  first transfer, in either direction.

- **Most recently used first.** Paired devices are listed by when you last
  transferred with them, and the desktop and Android show that time under
  the name.

- **A user guide in every app.** Everything the app can do on one page,
  linked from the home screen, in all six languages; Options > Help on
  Symbian.

### Changed

- **Paired devices take less room.** Each one is a single row with Send and
  Receive on it; the rest - send folder, send message, rename, remove - opens
  from the device's name. On the desktop this also gives a long device name
  the space the four buttons used to take.

- **Removing a paired device on the desktop** is confirmed in the device's
  own row, with the same question Android asks, instead of a bare system
  dialog.

### Fixed

- **A file dropped on the desktop window no longer replaces the app** with
  the file itself. Drops are refused everywhere except on a paired device.

[1.3.5]: https://github.com/Yenis/portal-gems/releases/tag/v1.3.5

## [1.3.4] - 2026-09-18

When a transfer goes wrong, the next one still works.

PortalGems Mini (Symbian) 0.9.1 adds Options > Settings > Server: the same
PortalGems / public / custom choice the other apps have, at cleartext
addresses the phone can reach. It turns out the public magic-wormhole mailbox
still answers plain WebSocket on port 4000, so a Symbian phone no longer
needs a self-hosted server to talk to anything - the README said it did, and
that is now corrected.

### Fixed

- **A paired send can be retried straight away.** Sending to a paired device
  uses a code both devices work out for themselves, and until now a send that
  was cancelled, timed out or crashed left that code unusable: trying again
  looked normal on the sending device, but the other one could never pick the
  transfer up, and there was nothing to do but wait up to five minutes for the
  code to change. Each code period now holds several, and a send that did not
  finish moves the next one on to the next code.

- **A stopped transfer no longer renames the next one.** On Android, a
  receive you cancelled - or one that failed - left its half-written file in
  the app's private staging folder, so the next file of that name arrived in
  Downloads as "name (1)" even when nothing there was called that. The
  partial file is now removed whenever a transfer does not finish, the file
  is saved under the name the sender offered, and anything left behind by the
  system killing the app mid-transfer is cleared at startup.

[1.3.4]: https://github.com/Yenis/portal-gems/releases/tag/v1.3.4

## [1.3.3] - 2026-09-18

Call your devices what you like.

### Added

- **Name your devices.** Settings now has a device name: what this device
  calls itself when you pair with another one, instead of a hostname or a
  model number like "sdk_gphone64_x86_64".

- **Rename a paired device.** Any device you have paired with can be renamed
  on your side - "Kitchen tablet", "Work laptop" - and the name is yours
  alone: nothing is sent anywhere, the other device never learns of it, and
  clearing the name brings back the one it gave. Both the desktop and Android
  rename from the device's row.

  The two are independent on purpose. Renaming your own device later does not
  reach devices already paired with you - they keep the name they learned,
  and can relabel you themselves.

### Fixed

- A device name typed in Settings on Android was lost if you left the screen
  with Back without tapping elsewhere first, because it was only saved when
  the field lost focus. Names are saved as they are typed now, on the desktop
  too.

[1.3.3]: https://github.com/Yenis/portal-gems/releases/tag/v1.3.3

## [1.3.2] - 2026-09-14

Pair two devices without a camera between them.

### Added

- **Pair using a code.** Pairing used to mean one device photographing the
  other's screen, which rules out two desktops, a phone whose camera is
  broken, and anything without a camera at all. Now either device can show a
  one-time pairing code instead, and you type it on the other. QR pairing is
  unchanged and still the quickest way when a camera is at hand: on the
  desktop the code comes first, and on Android it sits below the QR buttons
  for when the *other* device is the one without a camera.

  The same thing crosses either way - a device name and a random 256-bit
  secret - so a device paired by code and one paired by QR are
  indistinguishable afterwards, and pairings made by earlier versions keep
  working. A typed code carries the secret through an ordinary encrypted
  wormhole rather than across the room on a screen: one guess at the code,
  and a wrong guess fails visibly on both devices. One field accepts either a
  typed code or a pasted pairing code.

### Fixed

- **A paired receive could wait for ever.** If the sending device died while
  waiting - killed, crashed, out of battery - its claim on the one-time code
  stayed on the server, and the receiver would join it and wait for a
  handshake that could never arrive. The minute-long limit on the search was
  only checked between codes, never during one, so the screen sat there until
  it was cancelled. Each attempt is now given ten seconds before the receiver
  moves on to the next code.

[1.3.2]: https://github.com/Yenis/portal-gems/releases/tag/v1.3.2

## [1.3.1] - 2026-09-11

Send a text message, on every platform.

### Added

- **Text messages.** Type a message instead of picking a file and send it with
  a one-time code, on the desktop, on Android and on Symbian. Received
  messages can be copied straight out. It is the standard wormhole `message`
  offer, so `wormhole send --text` and `wormhole receive` interoperate with it
  in both directions.

  A message travels inside the offer itself rather than over a transit
  connection, which means the relay is never involved and no IP addresses are
  exchanged. The encryption is unchanged - it is an ordinary mailbox message
  sealed with a key from the same handshake. One difference is worth knowing:
  a message is delivered by the act of offering it, so unlike a file there is
  nothing to accept or decline.

  On Symbian (PortalGems Mini 0.6.0) it is Options > Send message; a received
  message opens in a scrollable dialog and stays under Options > Show message.
  Up to 400 characters, with accented letters converted properly rather than
  mangled.

[1.3.1]: https://github.com/Yenis/portal-gems/releases/tag/v1.3.1

## [1.3.0] - 2026-09-08

PortalGems runs on Symbian. A Nokia E72 from 2010 sends and receives files
and folders with the Android app, the desktop app, and the `wormhole` CLI.

### Added

- **Symbian support (S60 3rd edition, Feature Pack 2).** A separate client
  for Symbian OS 9.3 phones - the Nokia E72, E52, E55, E5, N86, X5 and their
  contemporaries - written from the protocol specification in freestanding
  C89, with a native Avkon interface. It sends and receives single files and
  whole folders in both directions, interoperating with every other
  PortalGems platform and with any magic-wormhole client. The installable
  package is 52 KB. Developed and tested on an E72.

  It needs a self-hosted server with a cleartext `ws://` listener, because
  Symbian's TLS is TLS 1.0 with a 2009 root store and cannot reach a modern
  `wss://` mailbox. That costs the handshake nothing: the mailbox carries
  only PAKE messages and ciphertext, so an observer on that port learns which
  code slot was used and when, never the key and never the file. See
  [PortalGems on Symbian](README.md#portalgems-on-symbian) and
  [docs/SYMBIAN.md](docs/SYMBIAN.md).
- **Direct connections on Symbian**, off by default and switchable in
  Settings. On a local network the phone connects straight to the other
  device instead of relaying.

### Fixed

- **No way to remove a paired device on Android.** Removing one was possible,
  but only by long-pressing the device's name - an invisible gesture with
  nothing on screen to suggest it, so in practice the option did not exist on
  the phone while desktop had a plain Remove button. Each paired device now
  shows Send, Receive and Remove buttons on Android too.
- **The remove confirmation said nothing.** The dialog repeated the word
  "Remove" as its only text. It now explains what happens: the device is
  unpaired, and you can pair with it again later.

### Note

The 1.2.8 version number was prepared but never tagged or published, so its
two Android pairing fixes above reach users for the first time here.

[1.3.0]: https://github.com/Yenis/portal-gems/releases/tag/v1.3.0

## [1.2.7] - 2026-09-04

Received files land where you chose, and the app tells you where they really
went. A desktop fix for files turning up in a folder you never picked.

### Fixed

- **Received files could land in a folder you never chose.** On desktop, the
  installed app shared one settings profile with builds run from source, so
  anything run on the same machine could quietly repoint your download folder
  and the installed app would obey it - saving your files somewhere you would
  never think to look. The installed app now keeps its profile to itself. Your
  existing settings and paired devices carry over untouched.
- **The "file saved" screen could name the wrong folder.** When your chosen
  download folder could not be used, PortalGems saved the file to Downloads
  but still named the folder you had picked, so the file looked like it had
  gone missing. It now names the folder the file is really in, and says when
  it fell back to Downloads.
- **A completed transfer no longer fails** when the chosen download folder has
  become unwritable - the file is saved to Downloads instead, rather than the
  transfer erroring out after the data has already arrived.

[1.2.7]: https://github.com/Yenis/portal-gems/releases/tag/v1.2.7

## [1.2.6] - 2026-07-20

Send whole folders, not just single files. Pick a folder and it arrives as a
folder on the other side - subfolders and all.

### Added

- **Send a folder** on Android and desktop. Choosing a folder shows its file
  count and total size before sending; the receiver sees the same and, on
  accepting, gets the folder rebuilt in their download location (nested
  subfolders included). It uses the standard magic-wormhole directory transfer,
  so it interoperates both ways with the `wormhole` command-line client and
  other compatible apps. Same-name folders warn first - overwrite or keep both,
  just like files.
- **Desktop remembers your last send folder**: the file and folder pickers
  reopen wherever you last picked from. (Android already does this through the
  system picker.)

### Fixed

- **Desktop download location could get stuck on a temporary path** left behind
  by an earlier build, silently saving received files somewhere unexpected.
  PortalGems now ignores such a path and falls back to your real Downloads
  folder, correcting the setting automatically.

[1.2.6]: https://github.com/Yenis/portal-gems/releases/tag/v1.2.6

## [1.2.5] - 2026-07-14

Your files, your folder. Received files can now land in a folder you choose,
and PortalGems asks before overwriting anything.

### Added

- **Default download location** in Settings, on Android and desktop. Pick any
  folder for received files, or keep the default Downloads folder. If the
  chosen folder goes missing, desktop recreates it; Android (where a deleted
  folder cannot be recreated) saves to Downloads instead and says so.
- **Same-name warning**: when an incoming file's name already exists in your
  download folder, PortalGems shows the existing file's size and asks -
  overwrite, keep both, or decline. An overwritten file is only replaced after
  the transfer has fully completed, so a failed transfer never costs you the
  original.

[1.2.5]: https://github.com/Yenis/portal-gems/releases/tag/v1.2.5

## [1.2.4] - 2026-07-14

Tidier settings. The language picker is now a compact dropdown, and on Android
the theme picker is a row of gem swatches.

### Changed

- **Language selector is now a dropdown** in Settings, on both Android and
  desktop, instead of a full list - room to add more languages without a long
  scroll. On desktop it uses a custom menu that matches the app's look rather
  than the default browser control.
- **Android theme picker** switched from a labelled vertical list to a
  horizontal row of the five gem swatches, with a **Current theme** label above
  so the active theme is always named.

[1.2.4]: https://github.com/Yenis/portal-gems/releases/tag/v1.2.4

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
