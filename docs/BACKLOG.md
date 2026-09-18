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

## Paired send: a dead sender burns its code for the rest of the bucket

A paired sender must use the code derived for the current five-minute
bucket - it cannot skip to another one the way a receiver can. If a sender
dies while waiting, its claim on that nameplate stays on the server.

Confirmed on the host (2026-09-18) against a local
`magic-wormhole-mailbox-server`, the one `docs/VPS-SETUP.md` installs, driving
the engine's own `send` and `recv` examples:

- A killed sender leaves its claim behind. A retry in the same bucket claims
  the nameplate a second time without error and sits on a perfectly normal
  waiting screen, so nothing on the sending device suggests a problem.
- The receiver that then joins is the third claim, and the server rejects it:
  `ServerError: crowded`. The send cannot complete for the rest of the
  bucket, and the failure surfaces on the wrong device.
- The sender retry is not even needed. A dead sender plus one bounded
  receiver attempt (`PAIRED_ATTEMPT_TIMEOUT_MS`) is enough: the receiver's
  own second poll of that code gets `crowded`, so the receive loop burns the
  nameplate by itself.
- A completed transfer releases cleanly - reusing a code after a successful
  send works - so back-to-back paired sends inside one bucket are fine. The
  fault is strictly the sender that does not finish.

It is also wider than a crash. The apps cancel by aborting the UniFFI future,
which drops the Rust future without sending a release, so a user-pressed
Cancel and an expired `PAIRED_SEND_TIMEOUT_MS` leave exactly the same stale
claim. That path was read in the code rather than reproduced on its own; at
the protocol level the socket just closes either way.

Both apps are affected: each send screen derives `currentBucket()` and
nothing else, and the two paired receive loops have the same shape.

Neither side is told what happened. The receiver polls for the full
`PAIRED_RECEIVE_TIMEOUT_MS` and then reports "nothing found", while the
sender blames the peer for never picking up. On a typed code the error
reaches `friendlyError`, where `SERVER_UNREACHABLE_RE` matches the word
"rendezvous" inside it and tells the user their server is unreachable,
offering to change it, when the server is fine.

**The shape of a fix**: a retry that moves to a fresh code both sides can
still find - an attempt counter folded into the derivation
(`portalgems-code-v1:{bucket}:{attempt}`) that the receiver adds to its
candidate list. The cost is a candidate set growing from 3 to 3xN, with a
stale nameplate charging the full attempt timeout on each pass, against a 60s
receive window. Cheaper, and worth doing either way: release the nameplate on
a graceful cancel and on the send timeout. That needs a real cancel future
plumbed through `ffi.rs` instead of cancel-by-drop, since a dropped future
cannot send anything - and it leaves only the true crash for the counter to
handle.

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
