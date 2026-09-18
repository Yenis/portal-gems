# Backlog

Things worth doing that are deliberately not being done yet. Each entry
says what the problem actually is, so the next person does not have to
rediscover it.

## Pairing without a camera - Symbian remaining

**Status:** shipped for the desktop and Android in 1.3.2. On Symbian the
portable C side is proven on the host against a real desktop instance, but
the phone build has not completed a pairing on the E72 yet: "Show a pairing
code" stalls on Connecting, and 0.7.1 adds the instrumentation to find out
why (a live step line with elapsed time and the worker's stack size, and a
worker that dies now reports its panic instead of leaving the screen
unchanged). The README still says Symbian cannot pair; that stays until it
does. See "Getting the payload across" in `docs/ARCHITECTURE.md`, and
"Pairing" in `docs/SYMBIAN.md`.

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

- **The Symbian client derives attempt 0 only.** `wh_pair_derive_code` in
  `native/wormhole-mini` takes a bucket and nothing else, so a sender that
  moved past its first code is invisible to a Symbian peer. Normal transfers
  are unaffected (attempt 0 is byte-identical to what it always was), and
  Symbian cannot pair at all yet, which is why this is not urgent - but the
  vectors for attempts 1 and 2 are already pinned in core's tests for
  `test_pair.c` to match.
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
- **`crowded` is reported as "your server is unreachable".** The engine's
  message contains the word "rendezvous", which `SERVER_UNREACHABLE_RE` in
  `packages/core/src/errors.ts` matches, so a typed code that hits a crowded
  nameplate tells the user to change servers when the server is fine. Needs
  one new string in all six locales.
- **A different device's dead send still burns the code.** The derivation is
  direction-agnostic, so if the peer was the one that died mid-send, the
  marker on this device knows nothing about it. Ground truth would be a
  `list_nameplates` probe in the engine before claiming; it costs a round
  trip per send and a rebuild of both bindings.

Pairing currently assumes one device can photograph another's screen. That
assumption fails in more cases than it holds:

- **Symbian.** The E72 has a camera, but the client cannot render a QR code
  and will not be running a scanner. Neither half of the current flow is
  available to it.
- **Two desktops.** Neither can photograph the other. There is a manual path
  today - *Show* displays a QR and offers **Copy payload**, and the pairing
  screen has a text field to paste one into - but it needs some other
  channel to carry the text between machines, and nothing in the UI suggests
  that is the intended route.
- **A phone with a broken or refused camera.** Same position as a desktop.

The obstacle is the payload's size, not the concept. It is JSON carrying a
32-byte secret in base64url:

```json
{"t":"portalgems-pair","v":1,"name":"...","secret":"..."}
```

Around a hundred characters. Fine to paste, unreasonable to type - and on a
phone keyboard, unthinkable.

**The shape of a fix**: pair over a one-time wormhole code rather than over
a QR image. One side shows a short code (`7-crossover-clockwork`), the other
types it, and the pairing payload travels through the wormhole as a normal
transfer. That reuses the whole stack, needs no camera anywhere, and asks
the user to type three words instead of a hundred characters. It also
happens to be the one input this project has already proved a fifteen-year-
old phone can manage comfortably.

Worth checking before building: whether the existing pairing handshake can
carry the payload as its first message, in which case this is mostly UI.

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
