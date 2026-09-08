<p align="center">
  <img src="assets/banner.png" alt="PortalGems gem portals" width="800">
</p>

# PortalGems

**Secure device-to-device file transfer, powered by the [magic-wormhole](https://magic-wormhole.readthedocs.io/) protocol.**

PortalGems sends files - or whole folders - from one device to another with
nothing but a short, one-time code - no accounts, no cloud storage, no
middleman that ever sees your data. It runs on **Android** and on the **desktop** (Linux, Windows, and macOS,
built with Electron), and it interoperates with **any** magic-wormhole client,
including the original `wormhole` CLI on a server or laptop.

It also runs on **Symbian** - a Nokia E72 from 2010 sends and receives files
and folders to and from a modern phone and laptop. As far as any public record
shows, this is the first magic-wormhole client for the platform. See
[PortalGems on Symbian](#portalgems-on-symbian) and
[A first for the platform](#a-first-for-the-platform).

---

## Table of contents

- [Download](#download)
- [Why PortalGems?](#why-portalgems)
- [Features](#features)
- [How it works](#how-it-works)
- [Security model](#security-model)
- [Device pairing (no backend)](#device-pairing-no-backend)
- [PortalGems on Symbian](#portalgems-on-symbian)
- [Architecture](#architecture)
- [Building from source](#building-from-source)
- [Development](#development)
- [A first for the platform](#a-first-for-the-platform)
- [License](#license)
- [Acknowledgments](#acknowledgments)
- [Self-hosting a server](#self-hosting-a-server)

---

## Download

Grab the latest build for your platform from the
**[releases page](https://github.com/Yenis/portal-gems/releases/latest)**:

| Platform | File | Notes |
|---|---|---|
| Android | `PortalGems-<version>-android.apk` | Sideload; enable "install from unknown sources" |
| Linux (portable) | `PortalGems-<version>-linux-x86_64.AppImage` | `chmod +x` then run; no install needed |
| Debian/Ubuntu | `PortalGems-<version>-linux-amd64.deb` | `sudo apt install ./PortalGems-*.deb` |
| Fedora/RHEL | `PortalGems-<version>-linux-x86_64.rpm` | `sudo dnf install ./PortalGems-*.rpm` |
| Windows | `PortalGems-<version>-windows-x64.exe` | Portable; just run it, no installer |
| macOS (Apple Silicon) | `PortalGems-<version>-macos-arm64.dmg` | Unsigned; right-click → Open on first launch |
| Symbian (S60 3rd ed. FP2) | `PortalGems-Mini-<version>-symbian.sis` | Self-signed; needs a self-hosted server. See [PortalGems on Symbian](#portalgems-on-symbian) |

Building from source instead? See [Building from source](#building-from-source).

### Verifying your download

Every binary ships with a matching `.sha256` file so you can confirm it
downloaded intact and untampered. After downloading both the binary and its
`.sha256`, run:

```bash
# Linux / macOS
sha256sum -c PortalGems-1.0.0-linux-x86_64.AppImage.sha256

# Windows (PowerShell) - compare the two hashes match
Get-FileHash PortalGems-1.0.0-windows-x64.exe -Algorithm SHA256
Get-Content PortalGems-1.0.0-windows-x64.exe.sha256
```

A matching hash means the file is byte-for-byte what was published.

## Why PortalGems?

Sending files directly from device to device can be needlessly complex - unless
you hand them over to yet another cloud service. Email attachments have size
limits, chat apps recompress your photos, cloud drives want accounts and sync
everything - and some ecosystems deliberately make moving files between your
laptop and your phone awkward unless both carry the right logo.

PortalGems takes a different approach, inherited from magic-wormhole:

- **One short code** (like `7-crossover-clockwork`) spoken, typed, or scanned
  once - that's the entire setup.
- **End-to-end encrypted, always.** The code bootstraps a strong shared key via
  a PAKE (password-authenticated key exchange). Nobody in the middle can read
  your file.
- **Direct when possible.** Two devices on the same Wi-Fi transfer directly,
  peer-to-peer, at LAN speed. A public relay is used only as a fallback - and
  it only ever sees ciphertext.
- **No accounts, no backend of ours, no stored data.** Everything lives on your
  devices.
- **Interoperable.** PortalGems speaks the standard magic-wormhole protocol, so
  you can send from your VPS with `wormhole send` and receive on your phone, or
  from your phone to a friend's laptop running any compatible client.

## Features

| | |
|---|---|
| Send & receive files | Between any two magic-wormhole clients, any direction |
| Send whole folders | Pick a folder and it arrives as a folder - subfolders and all, using the standard wormhole directory transfer (CLI-compatible) |
| Receive confirmation | See the file name and size - or the folder name, file count, and total size - and accept or decline before a byte flows |
| Your download folder | Pick where received files land (defaults to Downloads); same-name files and folders warn you first - overwrite or keep both |
| Direct LAN transfers | Same Wi-Fi → peer-to-peer at full speed, no relay |
| CLI interop | Works with `wormhole` on servers, laptops, anything |
| Device pairing | Scan a QR once; from then on, transfers need only a confirmation tap |
| Share-sheet integration | "Share → PortalGems" from any Android app |
| 6 languages | English, Deutsch, Bosanski, Русский, Français, Español |
| 5 gem themes | Diamond, Sapphire, Emerald, Ruby, Amethyst - each in light & dark |
| No accounts | No backend of ours, no cloud, everything stored locally |
| Built-in explainer | The full "how it works & why it's safe" story, in-app |
| Runs on Symbian | A separate 52 KB client for S60 3rd edition phones - files and folders, both directions |

## How it works

A transfer involves three parties: the two devices, plus a lightweight public
**mailbox server** used only for the initial handshake.

```
 Sender                        Mailbox server                      Receiver
   │  1. allocate mailbox,          │                                 │
   │     get code ────────────────► │                                 │
   │                                │ ◄──────────── 2. join with code │
   │  3. PAKE handshake (SPAKE2) - both sides derive the same         │
   │     strong session key from the short code ───────────────────► │
   │                                                                  │
   │  4. exchange connection hints (encrypted) ─────────────────────► │
   │                                                                  │
   │  5. TRANSFER: direct TCP if reachable (same Wi-Fi/LAN),          │
   │     otherwise via a transit relay - encrypted either way         │
   ▼                                                                  ▼
```

1. The **sender** connects to the mailbox server and gets (or supplies) a code
   like `7-crossover-clockwork`. The number is a "nameplate" (a rendezvous
   slot); the words are a one-time password.
2. The **receiver** enters the same code and joins the same mailbox.
3. Both sides run **SPAKE2**, a password-authenticated key exchange: from the
   short code, they derive an identical, strong 256-bit session key. A wrong
   code - or an attacker guessing - causes the handshake to fail *safely*, and
   the code is burned.
4. Using that key, the devices exchange **encrypted connection hints** (their
   IP addresses on local networks, etc.).
5. The file flows over the best available path: a **direct TCP connection**
   (same Wi-Fi → phone-to-phone at LAN speed) or, if the devices can't reach
   each other, through a public **transit relay** that blindly forwards
   encrypted bytes.

> **PortalGems is not an offline / LAN-only tool.** Even when the file itself
> travels directly over your local network (step 5), the two devices must first
> meet at the **mailbox server over the internet** to run the handshake (steps
> 1-3). That handshake *is* the security model - without a server to broker it,
> two devices have no way to find each other or agree on a key. So a connection
> to a mailbox server is **always required**; a direct LAN path only makes the
> transfer faster, it never removes the mailbox. (If you don't want to depend on
> the public server, run your own - see [Self-hosting a server](#self-hosting-a-server).)

The in-app **"How it works"** page explains all of this, in all six supported
languages.

## Security model

- **Confidentiality:** every byte of the file (and of the metadata) is
  encrypted end-to-end with keys derived from the SPAKE2 handshake. The mailbox
  server and the transit relay see only ciphertext and cannot decrypt anything.
- **Active attackers:** the code is single-use. An attacker who tries to
  intercept must guess the code *on the first try*; a failed guess is
  immediately visible to both users and invalidates the transfer.
- **Paired devices** use 256 bits of stored entropy instead of a two-word code,
  making online guessing effectively impossible.
- **No metadata trail:** no accounts, no server-side history, no telemetry.
  Pairing secrets are stored in the Android Keystore / OS keychain.
- **What we don't defend against:** an attacker with full control of *your
  unlocked device*, and traffic analysis (an observer can see *that* you
  transferred something and roughly how large it was, but not *what*).

## Device pairing (no backend)

The wormhole protocol lets a sender *choose* the code instead of getting a
random one. PortalGems uses this to make repeat transfers between your own
devices effortless - with no server involved:

1. **Pair once:** device A shows a QR code containing a device name and a
   random 256-bit secret; device B scans it (or you paste the pairing code by
   hand). Both store the entry locally (Keystore/keychain).
2. **Transfer forever after:** when you tap *Send* / *Receive* on a paired
   device, both sides independently derive the same one-time wormhole code from
   the shared secret and the current time window - and connect automatically.
   You just confirm the incoming file.
3. **Both apps must be open.** There is no background service and no push
   server. If the other device isn't listening, the transfer times out with a
   clear message.

Paired devices can be removed at any time. Losing a phone? Remove it on the
other device and the stored secret becomes useless.

## PortalGems on Symbian

PortalGems runs on **Symbian OS 9.3 / S60 3rd edition, Feature Pack 2** -
the Nokia E72, E52, E55, E5, N86, X5 and their contemporaries. It sends and
receives files and whole folders, in both directions, to and from PortalGems
on Android and the desktop, and to and from the `wormhole` CLI. Same
protocol, same codes, no bridge or gateway in between.

Developed and tested on an E72. Other FP2 devices should work and have not
been tried; earlier feature packs are not targeted by the package.

It is a **separate implementation**, not a port. Nothing in the Rust engine
can run on a 2010 ARMv5 phone with no modern toolchain, so the protocol was
rewritten from the specification in about 5,000 lines of **C89** that assume
no standard library, allocate no memory after startup, and keep every buffer
static. `native/wormhole-mini` is the client; `packages/app-symbian` is the
Avkon UI around it. The installable package is **52 KB**.

**What it does**

- Send and receive single files, to and from the memory card
- Send and receive folders, using the standard wormhole directory transfer -
  a folder sent from the phone arrives as a folder in the desktop app and
  under `wormhole receive` alike
- Enter a code on the keyboard, or generate one for the other side
- Direct LAN connections, off by default and switchable in Settings

**What it does not do**

- No QR pairing (there is no camera API worth the name here, and pairing is
  not implemented on this client yet), no themes, no translations
- **It needs a self-hosted server.** Symbian's TLS is TLS 1.0 with a 2009
  root store and cannot reach a modern `wss://` mailbox, so the phone talks
  to a cleartext `ws://` listener - one extra port on your own server, see
  [Self-hosting a server](#self-hosting-a-server). That costs less than it
  sounds: the mailbox only ever carries PAKE messages and ciphertext, so an
  observer on that port learns which code slot was used and when, never the
  key and never the file. Cleartext is exactly the setting a PAKE is
  designed for.

**Installing**

The `.sis` is **self-signed**, so the phone will warn that the supplier
cannot be verified and, on some firmware, that the application is not
compatible - both are expected; continue past them. It requests only
user-grantable capabilities (`NetworkServices`, `ReadUserData`,
`WriteUserData`). Copy the file to the phone and open it from the file
manager, then set your server under **Options > Settings**.

The build story - the toolchain on a modern Linux host, the protocol work,
and a long list of things that were only findable on real hardware - is in
[docs/SYMBIAN.md](docs/SYMBIAN.md).

## Architecture

One protocol engine, written in Rust on top of
[magic-wormhole.rs](https://github.com/magic-wormhole/magic-wormhole.rs)
(vendored with a small patch that adds the protocol's standard folder
transfer, `native/magic-wormhole/PORTALGEMS-PATCH.md`), shared by every
platform through thin bindings:

```
                ┌─────────────────────────────────────────────┐
                │             packages/core (TS)              │
                │ themes · 6 languages · pairing · error text │
                └──────────┬───────────────────────┬──────────┘
                           │                       │
             packages/app-mobile          packages/app-desktop
             (React Native, Android)   (Electron: Linux/Windows/macOS)
                           │                       │
             packages/wormhole-rn         native/wormhole-node
             (uniffi → JSI bindings)      (napi-rs addon)
                           └───────────┬───────────┘
                                       │
                        native/wormhole-core (Rust)
                    app-shaped API over magic-wormhole.rs
```

Symbian sits outside this tree entirely. `native/wormhole-mini` is a second,
independent implementation of the same protocol in freestanding C89, with
`packages/app-symbian` as its UI - see
[PortalGems on Symbian](#portalgems-on-symbian). It shares no code with the
Rust engine and is tested against it, which is the point: two implementations
written from the specification disagree loudly, and every disagreement so far
has been a real bug in one of them.

The full technical reference - engine API, binding layers, pairing protocol
spec, build system, testing, and a hard-won list of gotchas - lives in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Building from source

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- Node.js ≥ 20
- For Android: Android SDK + NDK, JDK 17
- Optionally the reference CLI for interop testing: `pipx install magic-wormhole`

### Android APK

```bash
cd packages/wormhole-rn && yarn install && yarn ubrn:android:release
cd ../app-mobile && npm install
cd android && ./gradlew assembleRelease
# → app/build/outputs/apk/release/app-release.apk
```

Release builds are signed with your own keystore via
`android/keystore.properties` (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md));
without one they fall back to the debug key.

### Desktop

**Linux** packages build locally:

```bash
cd packages/app-desktop && npm install
npm run dist:linux      # → release/  (AppImage + .deb + .rpm)
```

The `.rpm` target needs the `rpm` tool (`sudo apt-get install rpm`).

**Windows (`.exe`) and macOS (`.dmg`)** are built in CI on native runners
(see [`.github/workflows/release.yml`](.github/workflows/release.yml)) - the
napi-rs engine addon can't be reliably cross-linked to Windows from a Linux
host, so each desktop OS is built on its own runner. To build them by hand you
need the matching operating system; pushing a version tag builds and publishes
all platforms automatically.

### Symbian (`.sis`)

Needs the GnuPoc cross-toolchain and the S60 3rd edition FP2 SDK; setup for a
modern Linux host, including the patches that make a 2008 SDK work with a
current Perl, is in
[packages/app-symbian/toolchain/README.md](packages/app-symbian/toolchain/README.md).

```bash
export EPOCROOT=$HOME/symbian-sdk/s60_32/
export PATH=$HOME/symbian-sdk/gnupoc:$PATH
cd packages/app-symbian/group && bldmake bldfiles && abld build gcce urel
cd ../../.. && scripts/symbian-sign.sh
# → packages/app-symbian/sis/whmini-signed.sis
```

The C client builds and tests on the host on its own, with no SDK at all:

```bash
cd native/wormhole-mini
make test        # 191 checks against known-answer vectors
make test-arm    # the same suite cross-compiled and run under qemu-arm
make cli         # build/wh-mini, for interop testing against any client
```

### Tests

```bash
cd packages/core && npm test                      # protocol + i18n suites
cd native/wormhole-core && cargo test             # engine unit tests
cargo test -- --ignored                           # + network round-trip
```

## Development

Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - it contains the
system map, feature recipes (how to add a string, a setting, a screen, or an
engine capability), and the build gotchas. Historical design notes live in
[PLAN.md](PLAN.md) and `docs/phase*.md`.

## A first for the platform

No magic-wormhole client for Symbian appears to have existed before this one.
The protocol's own [ecosystem
list](https://magic-wormhole.readthedocs.io/en/latest/ecosystem.html) records
implementations in Python, Rust, Go, Haskell and Dart, and clients for desktop,
web, Android and iOS - nothing for Symbian, and no implementation in C at all.
The chronology is most of the explanation: magic-wormhole was first published
around 2015, and Nokia had wound down Symbian by 2012-2013. The two never
overlapped, so nobody had reason to write one.

That claim is bounded by what can be found. Symbian had a large hobbyist scene,
much of it never indexed and much of it not in English, and a client that was
written but never published would leave no trace. What can be stated precisely
is that no public implementation is known, and that this repository is the first
to publish one.

The audience deserves equal candor: Symbian is a dead platform, and this client
realistically has one user. I still carry an E72 - for music and podcasts, for
notes, and as a phone - and getting an MP3 onto it used to mean finding a USB
cable. Now it takes a code. That is why this exists, and it does the job well
enough that I use it.

The engineering is the part that outlives the platform. The transfer core is
portable C89 that assumes no standard library, allocates nothing after startup,
and makes no platform calls at all; every device-specific line sits behind one
small interface. It was written and proved against the real engine on a laptop,
cross-checked on 32-bit ARM under emulation, and only then met the phone. The
full account, including the failures that only appeared on real hardware, is in
[docs/SYMBIAN.md](docs/SYMBIAN.md).

## License

PortalGems is free software, licensed under the
**[GNU General Public License v3.0 or later](LICENSE)**.
It builds on [magic-wormhole.rs](https://github.com/magic-wormhole/magic-wormhole.rs)
(EUPL-1.2, combined and distributed under GPLv3 via the EUPL's compatibility
clause).

## Acknowledgments

- [Brian Warner](https://github.com/warner) and the
  [magic-wormhole](https://github.com/magic-wormhole/magic-wormhole) project -
  the protocol, the reference implementation, and the public mailbox/relay
  infrastructure.
- The [magic-wormhole.rs](https://github.com/magic-wormhole/magic-wormhole.rs)
  maintainers - the Rust implementation at the heart of PortalGems.
- Please be kind to the public community servers: for heavy use, consider
  self-hosting them.

## Self-hosting a server

PortalGems meets two devices at a **rendezvous** (mailbox) server to exchange
the short code, then moves the file directly or through a **transit relay** when
a direct connection is not possible. By default the app uses the **PortalGems
server**; in **Settings -> Connection server** you can switch to the public
community server or your own self-hosted one.

Running your own means you never depend on anyone else's uptime, and (since the
file is end-to-end encrypted) the server only ever sees ciphertext. You need a
small always-on machine - a cheap VPS is plenty. The steps below are the short
version; see **[docs/VPS-SETUP.md](docs/VPS-SETUP.md)** for the full runbook
(systemd services, TLS via Caddy, firewall, verification).

### 1. Install the servers

Both are maintained by the magic-wormhole project and run on Python 3:

```bash
python3 -m venv ~/wormhole && source ~/wormhole/bin/activate
pip install magic-wormhole-mailbox-server magic-wormhole-transit-relay
```

### 2. Run them

```bash
# Rendezvous / mailbox server - clients connect at ws(s)://host:4000/v1
twist wormhole-mailbox --port tcp:4000

# Transit relay - clients connect at tcp://host:4001
twist transitrelay --port tcp:4001
```

For a real deployment, run each under a process manager so it restarts on
reboot. A minimal systemd unit for the mailbox:

```ini
# /etc/systemd/system/wormhole-mailbox.service
[Unit]
Description=Magic Wormhole mailbox server
After=network.target

[Service]
User=you
# REQUIRED: the mailbox writes its channel DB (relay.sqlite) in its working
# directory. Without a writable one it crash-loops on startup (systemd's
# default cwd is `/`, which the service user can't write to).
WorkingDirectory=/home/you
ExecStart=/home/you/wormhole/bin/twist wormhole-mailbox --port tcp:4000
Restart=always

[Install]
WantedBy=multi-user.target
```

(Duplicate it for `transitrelay --port tcp:4001`, then
`sudo systemctl enable --now wormhole-mailbox wormhole-transitrelay`.)

### 3. Use TLS (recommended)

Mobile networks and browsers prefer secure WebSockets. Put a reverse proxy in
front of the mailbox so clients can reach it at `wss://relay.example.com/v1`.
With [Caddy](https://caddyserver.com) it is one line (automatic HTTPS):

```
relay.example.com {
    reverse_proxy 127.0.0.1:4000
}
```

The transit relay is a raw TCP protocol - expose port 4001 directly (open it in
your firewall); it does not need TLS because the payload is already encrypted.

**If you want to use the Symbian client**, also expose the mailbox's own
cleartext port 4000 (open it in your firewall, and in your provider's firewall
if you have one). Symbian cannot negotiate modern TLS, so it connects at
`ws://your-host:4000/v1`; the proxied `wss://` endpoint stays available for
everything else, and both reach the same mailbox and the same channels. See
[docs/VPS-SETUP.md](docs/VPS-SETUP.md) for the full setup.

### 4. Point the app at it

In **Settings -> Connection server**, choose **Custom** and enter:

- **Rendezvous URL:** `wss://relay.example.com/v1` (or `ws://your-host:4000/v1`
  without a proxy)
- **Transit relay URL:** `tcp://your-host:4001`

Leave a field blank to keep the public default for just that server. Every
device you want to connect must use the **same** rendezvous server. Because
PortalGems keeps the standard magic-wormhole app id, the reference `wormhole`
CLI pointed at your server (`wormhole --relay-url ... --transit-helper ...`)
interoperates too.

### Common pitfalls (learned the hard way)

- **The mailbox crash-loops on startup.** It can't write `relay.sqlite` in its
  working directory. Set `WorkingDirectory` on the service to a writable path
  (see the unit above), then `systemctl reset-failed wormhole-mailbox` and
  restart.
- **Phones can't connect over plain `ws://`.** Android blocks cleartext traffic
  by default, so for mobile the mailbox effectively **must** be `wss://` (TLS) -
  do step 3 (Caddy). Desktop works fine with plain `ws://`. TLS is one line with
  Caddy and the cert is issued automatically, so just use it.
- **Transit port 4001 is unreachable even after `ufw allow`.** Your VPS
  provider almost certainly has its own cloud firewall / security group. Open
  **4001** (and 443) there too - non-standard ports are commonly blocked
  upstream even when the host firewall allows them.
- **You already run a web server on port 80.** Caddy can serve the mailbox on
  443 without touching 80: add a global `{ http_port 8080 }` block to the
  `Caddyfile` so Caddy never binds 80; the certificate still issues via the
  TLS-ALPN challenge on 443. Your existing site on 80 is untouched.
- **Always verify before trusting it.** Run a round-trip with the reference CLI
  pointed at your server (both `--relay-url wss://host/v1` and
  `--transit-helper tcp:host:4001`) - if that works, the app will too.

Full, corrected, copy-paste runbook with all of this baked in:
**[docs/VPS-SETUP.md](docs/VPS-SETUP.md)**.
