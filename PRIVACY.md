# Privacy

Last updated: 2026-10-11

PortalGems moves files and messages from one device to another. It has no
accounts, no analytics, no advertising and no telemetry, and the people who
make it cannot read anything you send. This page says exactly what leaves
your device, who can see it, and what is kept.

## What stays on your device

Everything the app stores is stored locally and never uploaded:

- **Paired devices** - the name of each device you paired with, and the
  secret the two devices share. On Android this is held in encrypted
  storage backed by the system keystore; on the desktop it is encrypted
  with the operating system's keychain where one is available, in a file
  only your account can read; on Symbian it is in the app's private
  directory.
- **Settings** - language, theme, download folder, device name, which
  connection server you chose, and whether notifications are on.

The app keeps no history of your transfers. Removing a paired device
deletes its secret. Uninstalling the app on Android removes everything
above. On the desktop, uninstalling leaves the app's profile folder behind,
as desktop programs usually do; deleting that folder removes the rest
(`~/.config/portalgems-desktop` on Linux, `%APPDATA%\portalgems-desktop`
on Windows, `~/Library/Application Support/portalgems-desktop` on macOS).

## What leaves your device

A transfer makes two kinds of connection, and nothing else in the app
contacts anything:

1. **To a connection server**, so that the two devices can find each
   other. It is told a meeting-slot number and passes a handful of small
   encrypted messages between the two devices.
2. **To the other device**, directly when the two can reach each other, or
   through a relay when they cannot.

Your files and messages, their names and their sizes are encrypted on your
device with a key that only the two devices hold. A connection server or a
relay cannot read them. What they can observe is what any server can: the
internet address a connection comes from, when it happens, the meeting-slot
number, and - for a relay carrying a transfer - roughly how much encrypted
data passed.

## The servers

You choose the connection server in Settings.

### The PortalGems server (the default)

Run by the maintainer of PortalGems. It is set up to write nothing down
about the people who use it:

- No log of connections or requests is kept. Both services run with their
  logging limited to errors, and the web server in front of them has no
  access log.
- No usage statistics are collected.
- An internet address is known to the server only for as long as its
  connection lasts, because a connection cannot exist without one.
- Open meeting slots, and the encrypted messages waiting in them, are held
  until both devices are done or the slot expires, and then removed. They
  are not tied to an address.

The server's firewall keeps no log either. One thing is outside the
maintainer's control, and is said here so that this page is not more
reassuring than the facts: the company hosting the server may keep network
records of its own.

The exact setup is public, in [docs/VPS-SETUP.md](docs/VPS-SETUP.md), with
the commands to check that a server really is logging nothing.

### The public magic-wormhole server

Run by the magic-wormhole project, not by PortalGems. It can see the same
things described above; what it records is up to its operators.

### Your own server

If you run your own, what it records is up to you. The setup guide shows
how to run one that records nothing.

## Symbian

PortalGems Mini talks to the connection server without transport
encryption, because the phone cannot do modern TLS. Your files and
messages are still encrypted end to end, exactly as on the other
platforms. The difference is that someone watching the network between the
phone and the server can see the meeting-slot number and the timing, which
on the other platforms only the server sees.

## Permissions (Android)

- **Internet** - to make the two connections above.
- **Notifications** and **foreground service** - to keep a transfer alive
  while the screen is off and to tell you when one ends. Notifications can
  be switched off in Settings.
- **Camera** - asked for only when you scan a pairing QR code.
- **Storage** - on Android 9 and older only, to save received files.
  Newer versions need no storage permission.

Files are read only when you pick or share them, and written only to the
download location you chose.

## Children, sale of data, third parties

There is no data to sell or share: none is collected. The app contains no
third-party trackers or advertising code. It is not directed at children
and treats every user the same way, by knowing nothing about them.

## Changes and questions

If this page changes, the date at the top changes with it, and the history
is public in the repository. Questions can be raised at
<https://github.com/Yenis/portal-gems/issues>.
