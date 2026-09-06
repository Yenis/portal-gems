# Backlog

Things worth doing that are deliberately not being done yet. Each entry
says what the problem actually is, so the next person does not have to
rediscover it.

## Pairing without a camera

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

## Using the reference CLI against the PortalGems server

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

This trips people up repeatedly and deserves better than a footnote - a
small wrapper script in `scripts/`, or a documented alias, so the terminal
path is as easy as the app.
