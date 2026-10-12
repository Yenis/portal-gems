# Backlog

Things worth doing that are not done yet, and what has been decided about
them. Each entry says what the problem actually is, so the next person does
not have to rediscover it. Reviewed against the code at 1.4.4 (2026-10-11).

## Open gaps, in the order they are to be worked

1. The stale claim is never released
2. What has not been verified end to end
3. A connection lost while waiting goes unnoticed

The first is under "Paired send" below, with the findings it comes from.

### What has not been verified end to end

- QR *camera* scan, which needs a real phone.
- Cancel in the middle of a transfer. Cancel while waiting is verified on
  both engines; `cancelled_receive_leaves_no_partial_file` covers the
  engine's side of a dropped receive, not the apps' screens.
- The paired-transfer buttons in the UI. The desktop smoke modes drive the
  same code underneath them.

Android has one Jest file and the desktop two test files, so the UI on both
is covered by hand and by the smoke harness. That Jest file is the React
Native template's and is not in CI (`.github/workflows/test.yml`): it needs
the native modules mocked before a pass would mean anything.

The connect timeout (`CONNECT_TIMEOUT`, 20 s) is covered by a unit test
against a server that never answers; it has not been watched on a phone
with its Wi-Fi off, which is where the hang was first seen.

A crowded code now has its own error (`Error::Crowded`, shown as "This code
can no longer be used") instead of being reported as an unreachable
server. The conversion is unit-tested; nobody has put three devices on one
code and read the screen. On Symbian the same case says "That code is not
waiting on this server", which is imprecise but does not send the user off
to change servers, so it was left alone.

Symbian's later paired codes (PortalGems Mini 0.13.0) are tested on the
host and under qemu-arm against core's vectors. Not yet done: a
`wh-mini paired-send --attempt 1` picked up by a real desktop, and on the
E72 itself a paired send cancelled and then repeated inside one bucket.

Notifications: seen working on the desktop (Linux). Not yet seen on
Android, where the Kotlin (`notifyFinished`) has not even been compiled
outside a release build, nor on Windows, where a portable `.exe` is the
least certain case for the AppUserModelID.

### A connection lost while waiting goes unnoticed

The connect timeout covers reaching the server and stops once the code is
claimed. A sender whose Wi-Fi drops after that, while its code is on screen,
still shows a code nobody can use until the user cancels. Telling that apart
from an ordinary wait needs a liveness check on the mailbox connection
(a WebSocket ping), inside the vendored crate.

### Left from the security review (2026-10-11)

The review and its fixes are in `docs/ARCHITECTURE.md` section 7, and
went out in 1.4.4.

**Parked on 2026-10-12, to be picked up later.** None is urgent; they are
written down so that they are not forgotten:

- **Pin the CI actions to commits.** `actions/checkout@v4`,
  `actions/setup-node@v4` and `dtolnay/rust-toolchain@stable` are labels
  their owners can move, and the release job that uses them holds the
  Android signing keystore. Replacing each label with the commit SHA of the
  version in use, with the version in a comment beside it, means the code
  cannot change underneath a release. Ten minutes and no change in
  behaviour; the price is bumping the SHAs by hand now and then. The
  quickest of the three, and the one that guards the signing key.
- **Update the build tooling.** `npm audit` lists advisories in Vitest and
  its dependencies (`packages/core`), the React Native CLI, Metro and Jest
  (`packages/app-mobile`), and electron-builder's downloader
  (`packages/app-desktop`). None of it is inside an APK or an installer;
  the exposure is the machine doing the build. Run `npm audit fix` in each
  of the three, then build and test - Android above all, since its tooling
  is the touchiest about versions. It failed in the sandbox on an npm
  error (`Cannot read properties of null (reading 'edgesOut')`), so it
  wants a normal machine.
- **Sign the release checksums.** Each download has a `.sha256` beside it,
  which proves the file arrived intact and not who made it: whoever could
  replace a binary on the release page could replace its checksum too.
  A signing key kept offline, its public half published somewhere other
  than the release page, and one signed checksum list per release would
  let a download be verified without trusting the download site. It adds a
  manual step to every release and a key that must never be lost or
  leaked, so it is a decision about how much release ceremony is wanted.
  Code signing for Windows and macOS is a separate matter and costs money
  every year.

**Done since, and not yet released** (committed after 1.4.4):

- A received archive is capped by number of entries (`entry_cap`,
  `wh_entry_cap`), and an overflow in the byte cap is fixed. Both are in
  the engine, so they reach each app with its next native build: the
  desktop addon, the Android libraries, and a new Symbian `.sis`.
- The desktop's keyboard and scrolling changes: pages start at the top,
  the title stays in reach, Enter and Escape work.

**Standing notes:**

- **The server keeps no logs, and that was checked.** On 2026-10-11 the
  PortalGems server turned out to be writing each HTTP request to the
  journal with its address. Both services now run with
  `--log-level=error`, confirmed on the server after a transfer; the
  firewall's logging is off and the old journal was cleared the same day.
  `docs/VPS-SETUP.md` has the flag and a section on checking a running
  server. Worth re-running those checks after any change to the server.
- **The license list is regenerated by hand.** `scripts/gen-licenses.mjs`
  must be run after a dependency changes; nothing in CI notices when
  `licenses.json` and `THIRD-PARTY-LICENSES.txt` have fallen behind. The
  Android app does not carry the license texts themselves, only the list
  and the address where they are.

## Features: what has been decided (2026-10-11)

Undecided:

- **A verification string** - a short phrase both people compare before a
  one-time-code transfer proceeds, as `wormhole --verify` does. If it is
  ever built: an off-by-default setting, one-time codes only. It costs one
  spoken comparison and a tap on each side, and the sender can no longer
  start a send and walk away. Parked.

Later, not now:

- **Updates.** Wanted: an auto-update toggle and a "Check for updates"
  button in Settings, against the GitHub releases - a sideloaded APK and a
  portable `.exe` otherwise never learn that a new version exists. Delayed
  until its shape is decided, because "auto-update" cannot mean the same
  thing everywhere. An AppImage can replace itself. A `.deb` or `.rpm`
  belongs to the package manager, a running portable `.exe` cannot cleanly
  replace itself, and an unsigned macOS app cannot self-update at all.
  Android can download the APK and open the system installer, with a
  confirmation each time and the "install unknown apps" permission. Symbian
  cannot reach GitHub over modern TLS. So the choice is between "check and
  tell" - say a newer version exists and open the download page, the same
  on every platform, no new permissions - and "install where possible",
  which behaves differently per platform and must be switched off again
  for F-Droid, which does not allow self-updaters. Also open: whether the
  automatic check is on by default, since it would be the only time the
  app contacts anything but the chosen connection server.
- **F-Droid recipe and store metadata.** Planned; the "no proprietary
  dependencies" discipline in `docs/ARCHITECTURE.md` section 5 exists for it.

Decided against:

- **iOS.** `packages/app-mobile/ios` is the untouched React Native template.
  Everything in the Kotlin `PortalGemsNative` module would need a Swift
  counterpart, and the platform allows no distribution outside a paid
  developer account and Apple's own channels.
- **Sending several files from Symbian.** It receives a selection and sends
  one file or one folder at a time, which is enough.
- **A desktop tray icon that keeps listening for paired devices.** It would
  make phone to laptop one tap, but only that direction: Android stops a
  background app unless it holds a permanent foreground service or uses
  Google's push, and neither is wanted. It also needs engine work, because
  polling as the Receive button does - a new connection per code - cannot
  run around the clock; the listener would have to ask one long-lived
  connection for the nameplate list, as the Symbian client does. Not worth
  it for half the benefit.
- **Sending the clipboard to a paired device.** A message can already be
  typed or pasted into the send screen.
- **"Open" and "Show in folder" after a receive, and actions on a
  notification.** A received file should never be opened by accident; the
  notification only says what happened.
- **A QR code for a one-time code.** The code is short enough to type.
- **A transfer history.** Nothing about past transfers is stored.

## Paired send: the codes a dead sender leaves claimed - what is left

The original problem: a paired sender must use the code derived for the
current five-minute bucket, and a sender that dies while waiting leaves its
claim on that nameplate. Confirmed on the host (2026-09-18) against a local
`magic-wormhole-mailbox-server`, the one `docs/VPS-SETUP.md` installs:

- A killed sender leaves its claim behind. A retry in the same bucket claimed
  the nameplate a second time without error and sat on a perfectly normal
  waiting screen, so nothing on the sending device suggested a problem.
- The receiver that then joined was the third claim, and the server rejected
  it: `ServerError: crowded`. The send could not complete for the rest of the
  bucket, and the failure surfaced on the wrong device.
- The sender retry was not even needed. A dead sender plus one bounded
  receiver attempt (`PAIRED_ATTEMPT_TIMEOUT_MS`) sufficed: the receiver's own
  second poll of that code got `crowded`.
- A completed transfer releases cleanly, so back-to-back paired sends inside
  one bucket were always fine. The fault is strictly the sender that does not
  finish - and that includes a user-pressed Cancel and an expired
  `PAIRED_SEND_TIMEOUT_MS`, not only a crash.

**Fixed:** each bucket now holds `PAIRED_CODE_ATTEMPTS` codes instead of one.
A marker written before a paired send, and cleared only when one completes,
tells the next send to move on to the following code; the receiver looks for
all of them (`candidateCodes`). Verified end to end on the local server: a
killed sender, a retry, and a receiver that walks its candidate list pays one
bounded 10 s attempt on the dead code and then completes on the next one -
where before, the same retry left the receiver with `crowded` and no way
through until the bucket rolled over.

What that does **not** cover, in the order it is worth doing:

- **The stale claim is still never released.** The cheap-sounding fix - hand
  the engine a real cancel future instead of cancel-by-drop - does not work:
  `sender_connect` claims the nameplate in `MailboxConnection::connect` and
  then waits inside `Wormhole::connect(mailbox)`, which consumes the mailbox,
  and `wormhole-core` races that whole future against `cancel`, so the losing
  side is dropped either way. `MailboxConnection::shutdown` (it sends
  `release` then `close`) can only be reached by keeping the mailbox alive
  across cancellation, which means patching the vendored crate. Worth doing
  only if stale claims turn out to matter beyond the retry case, since the
  attempt codes already route around them.
- **A different device's dead send still burns the code.** The derivation is
  direction-agnostic, so if the peer was the one that died mid-send, the
  marker on this device knows nothing about it. Ground truth would be a
  `list_nameplates` probe in the engine before claiming; it costs a round
  trip per send and a rebuild of both bindings.

## ~~Android: a cancelled receive leaks its partial file and renames the next~~ - done

Found while testing pairing, unrelated to it. The engine staged an incoming
file in the app's private `incomingDir` under a never-overwrite name. A
receive that was cancelled or failed left its partial file there, so the next
transfer of the same name was staged as `name (1).ext` - and `ReceiveScreen`
took the final name from the staged path, so the `(1)` reached Downloads even
when nothing there had that name. Both halves were reproduced on the host:
killing a receive mid-transfer left a 5 MB partial behind, and the next
transfer of that name arrived as `big (1).bin`.

Three changes:

- `PendingReceive::accept` guards the staged file and the unpacked folder
  with `Drop` rather than an error branch. Cancellation is not an error
  return: the apps abort the UniFFI future, which drops the Rust one
  mid-write, so nothing after the `await` would run. The folder path's zip is
  still removed on every outcome.
- `ReceiveScreen` saves under the offer's own name, not the staged file's.
- Android empties the staging directory at app start, the only cover for a
  process the OS kills outright, where no `Drop` runs.

`cancelled_receive_leaves_no_partial_file` covers the regression: an
`#[ignore]`d network test that cancels the way the apps do, by dropping the
future, and fails without the guard. The fix reaches a phone only once the
native library is rebuilt, and has not been re-run on a device yet.

Only Android showed the rename, because only Android stages every transfer
into one shared directory and took the saved name from the staged path.
Desktop downloads were never affected either way: each one gets its own
`incoming/<id>` directory, removed in a `finally`. The leak itself was in the
engine, though, so it reached further than the symptom did - the pairing
handshake accepts into a shared directory on both platforms (the OS temp
directory on the desktop, `incomingDir` on Android), where a cancelled or
failed handshake left its partial `pg-pair-handshake.json` behind for good.
Harmless, since that path is used as returned and then deleted, but it is the
same fault and the same guard fixes it. The Symbian client has its own C
implementation and never ran this code.

## ~~Using the reference CLI against the PortalGems server~~ - done

`wormhole receive <code>` fails against a code issued by a PortalGems client
with `ServerError: crowded`, or with a nameplate that does not exist. The
reason is mundane - the reference client defaults to the **public** relay:

```
rendezvous: ws://relay.magic-wormhole.io:4000/v1
```

so it looks for the code on a different server entirely, where that
nameplate belongs to somebody else. Nothing is broken; the flags are simply
required:

```sh
wormhole --relay-url ws://<server>:4000/v1 \
         --transit-helper tcp:<server>:4001 receive <code>
```

`scripts/pg-wormhole.sh` supplies them. Usage is exactly the CLI's:

```sh
scripts/pg-wormhole.sh send ./file
scripts/pg-wormhole.sh send ./folder
scripts/pg-wormhole.sh receive 7-crossover-clockwork
```

`PG_RENDEZVOUS_URL` and `PG_TRANSIT_URL` override the server, using the same
names `native/wormhole-core`'s examples use. It also translates the transit
relay from the URL form the apps carry (`tcp://host:port`) to the form the
CLI wants (`tcp:host:port`), so a value can be copied out of the app's
settings unedited.
