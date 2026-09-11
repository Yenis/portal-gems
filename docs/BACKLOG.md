# Backlog

Things worth doing that are deliberately not being done yet. Each entry
says what the problem actually is, so the next person does not have to
rediscover it.

## Pairing without a camera - in progress

**Status:** pairing over a code is built and verified on the desktop (two
desktops paired with each other, then transferred between the new pairing)
and on Android, where it sits below the QR buttons as the alternative for a
peer without a camera (verified on an emulator against the desktop in both
directions, plus a paired transfer). On Symbian the C side is proven on the
host against the desktop and the phone build is ready; it has not yet been
run on the E72 itself. See "Getting the payload across" in
`docs/ARCHITECTURE.md`, and "Pairing" in `docs/SYMBIAN.md`.

## Android: a cancelled receive leaks its partial file and renames the next

Found while testing pairing, unrelated to it. The engine stages an incoming
file in the app's private `incomingDir` under a never-overwrite name. A
receive that is cancelled or fails leaves its partial file there, so the next
transfer of the same name is staged as `name (1).ext` - and `ReceiveScreen`
takes the final name from the staged path (`savedPath.split('/').pop()`), so
the `(1)` reaches Downloads even when nothing there has that name. Two small
fixes: save under the offer's own name, and delete the staged file when the
transfer does not complete. Desktop is not affected; it stages each transfer
in its own `incoming/<id>` directory.

## Paired send: a dead sender blocks its own code for the rest of the bucket

A paired sender must use the code derived for the current five-minute
bucket - it cannot skip to another one the way a receiver can. If a sender
dies while waiting, its claim on that nameplate stays on the server.

Observed: a receiver that joins such a nameplate waits for a handshake that
never comes (now bounded by `PAIRED_ATTEMPT_TIMEOUT_MS`), and once further
claims pile up the server rejects the nameplate outright. Not yet observed
directly, but implied by the same mechanism: a sender retrying within the
same bucket lands on that stale nameplate too, since it has no other code to
use. If that holds, a paired send interrupted by a crash cannot be retried
until the bucket rolls over. Worth confirming first; the fix would be a
retry that moves to a fresh code both sides can still find.

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
