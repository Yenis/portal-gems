# Messaging between paired devices - plan, revision 2

Status: **planning, nothing built** (2026-10-12, branch `messaging`).

This follows `docs/MESSAGING-DESIGN.md` and
`docs/MESSAGING-DESIGN-REVISION-1.md`, both kept as written. Where they
disagree with this file, this one is right. Item numbers such as "5.8"
refer to the first document. Rotation of the pairing secret now has its
own document, `docs/PAIRING-ROTATION-DESIGN.md`, and is to be built on
master first.

Nothing here has been tested.

One correction to revision 1, section 3: it said that when two devices
fall out of step "the app can say so". It cannot, as things stand - out of
step looks exactly like "the other device is not there". The rotation
document takes this up (its item 9.1).

## 1. Decided in this round

| Subject | Decision |
|---|---|
| Mailbox server | **Not patched.** No fork to maintain, and the project stays inside the wormhole protocol as stock servers speak it. A custom server remains an idea for a separate, fully custom "PortalGemsPlus" some day (section 9). |
| Rotation of the pairing secret | Its own project, designed in its own document, built on master first. Chat builds on it. |
| Telling the two devices apart | A role recorded at pairing ("first" showed the code, "second" joined). Both can send; the role only gives the two directions different codes. **Pairings made by older versions must be paired again to use chat.** |
| Byte limit | Every device has a ceiling. A device announces its own limit, and the sender applies it. |
| Public server | Chat is disabled there, deliberately, and the app says why: to keep from overloading a volunteer-run server. (Pairing does work there; the app has to block chat itself.) |
| When the conversation is forgotten | When the app's process ends. Not on leaving the chat screen, not on going to the background. |
| A peer with chat switched off | Looks like a peer that is not there. Good enough. |
| Screenshots | Blocked in the chat on Android. The desktop is left alone for now. |
| Message format | Carries an identity from the start. A version field too, if it is cheap - it is one entry. |
| Clean release of a claim | Agreed as a prerequisite. It needs no server patch (section 2). |
| 5.5, 5.6, 5.7 | Understood and agreed. |

A consequence of two of these together: since chat requires a new pairing
anyway, the device's limit can be exchanged **at pairing**. The worry that
a first message is sent before the sender knows the receiver's limit then
does not arise - by the time a chat is possible, both limits are known.

## 2. Without a server patch: each problem and its answer

Everything the patch would have done, and what is done instead with a
stock server.

### The cheap poll

**Does the `list` probe need a server patch? No.** `list` is an ordinary
command every mailbox server answers; the reference client uses it to
complete codes as you type. Our Rust engine already uses it when a
receiver joins a code, and the Symbian client already polls with it
(`wh_mailbox_nameplate_listed`). What is new is only a function in our own
engine that asks for the list and compares it with the codes we expect.
The crate's `list_nameplates` is already public, so this may not even
touch the vendored crate.

One connection can ask again and again. So a device in a chat keeps one
connection to the server open and sends one small request per poll. That
connection carries no keys and no messages, and a poll that gets no reply
is how a dead connection is noticed.

One thing to check on Symbian: its list reader gives up when the list is
too long for its buffer. On our own server the list is short; it has to
stay readable as use grows.

### A sender that gives up (5.5)

**The clean release needs no server patch either.** "Release" and "close"
are ordinary commands. The engine simply does not send them when a wait is
cancelled, because cancelling drops the connection. The fix is in the
vendored Rust crate and in our C client.

### "Take a new claim and let the failed one die"

Yes - and that is what the three codes per bucket already do. There are
only three because, with today's polling, every extra code is another
connection the receiver must try. With the `list` poll, checking a code
costs nothing: the receiver has the whole list and compares. So the number
of codes can be as large as we like, up to the point you first asked for:
**a new slot for every message, never used twice.**

Proposal:

- A chat code is derived from the pairing secret, the direction, and **the
  second in which the message was sent**. The one-message-per-second limit
  makes each code unique without any counter to store.
- A slot is never reused. A failed message that is retried goes out on a
  new slot, with the same message identity.
- The receiver computes the codes for the recent past (the 2-minute wait
  plus the clock tolerance), looks for them in the list, and joins only
  **the newest one it finds**. Only one message is in flight at a time, so
  the newest listed slot is the only one that can be alive; anything older
  is a leftover.
- A slot the receiver joined and found dead is remembered and not tried
  again.

With that, a leftover claim costs nothing but a line in the server's list
until it expires. Three codes per bucket (5.6) stops being a limit, and a
crash (5.7) leaves one dead slot that costs the receiver, at worst, a
single 10-second wait.

To be costed on Symbian: computing a few hundred codes when the chat
opens, then one more each second.

The clean release is still worth doing: it keeps the server's list short,
and paired transfers benefit from it too.

### Someone else on the slot (5.11)

Hiding the list would stop it, but the poll above depends on the list. So
for now it is accepted: a stranger can make one exchange fail, cannot read
or forge anything, and the retry button covers it. This is the one problem
that stays open without a custom server.

### Faster expiry of abandoned slots

Not needed. With slots never reused and only the newest joined, how long a
dead one lingers does not matter.

## 3. Polling speed and the load on the server

Faster polling does not depend on a server patch, only on the `list` poll.
What a chat costs the server:

- **Per device with a chat open:** one idle connection, and one small
  request per poll. The reply is the list of active slots, about twenty
  bytes each.
- **Per message:** one short wormhole - about ten small protocol messages
  and a handful of database writes - the same as sending one text today.
- **Nothing** for a device that does not have a chat open.

For comparison, today's method would open up to nine TLS connections per
poll per device.

Proposed: poll every **5 seconds for one minute after any message is sent
or received, otherwise every 30 seconds.** Both numbers are single
constants.

What nobody knows yet is how many open chats a small server carries
comfortably. That should be measured, not guessed: a local mailbox and a
script that holds a few hundred polling connections, before the numbers
are fixed. Proposed as a step of its own.

## 4. The queue rules, explained

The situation: you type three messages quickly. Each needs its own
exchange, and an exchange can take from two seconds to two minutes.

1. **One message is in flight at a time.** The second waits for the first
   to be acknowledged, the third for the second. Otherwise three messages
   would be waiting on three slots at once, and they could arrive in any
   order.
2. **If the first one times out, the ones behind it fail with it.** If the
   other device is not there, all three fail after two minutes, each with
   its own retry button. Without this rule the second would start its own
   two-minute wait, then the third: six minutes to learn that nobody is
   there.
3. **Messages follow each other without waiting for the poll.** As soon as
   the receiver has one message it looks again at once, and the sender
   sends the next at once. Only the first of a burst waits for a poll.
4. **A waiting message can be cancelled.** It becomes a failed message
   with a retry button.

What you would see on a message, in order: waiting for the other device;
then sent, or failed with retry.

Still wanted from you: agreement, or a different rule for 2 (for example,
retrying one failed message retries all of them).

## 5. Suggested numbers

| What | Suggestion | Why |
|---|---|---|
| Typed length | 400 characters | Decided. |
| Byte ceiling, phone and desktop | 2,000 bytes for the whole message | 400 characters of any script fit (at most 1,600 bytes) with room for the identity and framing. |
| Byte ceiling, Symbian | What the phone announces: 1,000 bytes today | Its buffer. Raising the buffer is possible later and would then be announced. |
| Conversation kept in memory | The last 500 messages per paired device | About 1 MB at the very worst. The oldest drop off, and the screen says so. |
| Sending | 1 message per second | Decided. |
| Receiving | One exchange at a time; anything over the ceiling refused | The sender's limit cannot be trusted. |
| Wait for the other device | 2 minutes | Decided. |
| Polling | 5 s when active, 30 s when idle | Section 3; to be confirmed by measurement. |

When a message is too long for the device it is going to, the sender is
told before sending, with the reason.

## 6. What "forgotten when the process ends" brings with it

- Conversations with several devices can be held at once, each until the
  app closes.
- **Android may end a background app at any moment without asking.** The
  conversation is then gone with no warning. The disclaimer has to say
  this plainly.
- Leaving the chat screen keeps the conversation but stops the polling for
  it, so messages sent to you meanwhile time out on the other side.
  Whether the app should instead keep polling while it is in the
  foreground on another screen is open (section 10).

## 7. Symbian

**A custom chat screen is possible.** The app is an ordinary Avkon
application and can draw its own view: a scrolling list of messages with a
text field below. That part is design work, not a limit.

The real constraint is underneath. The Symbian client runs one blocking
exchange on a worker thread. While it waits up to two minutes for its own
message to be picked up, it is not looking for yours. Options: a second
worker thread, or giving the waiting sender a turn to poll every few
seconds. Both touch the most delicate part of that client (8 KB stacks,
fixed buffers) and want a design section of their own once the rest is
settled.

## 8. Do our patches to the Rust crate affect interoperability?

No. Both patches expose things the wormhole protocol already defines and
the released crate simply did not make available:

- **Folders** are sent as the protocol's own `directory` offer, the one
  the Python reference client sends for `wormhole send <dir>`. Verified
  against the reference client in both directions.
- **Text** is the protocol's own `message` offer. Verified against
  `wormhole send --text` and `wormhole receive` in both directions.
- **Several files** add one extra entry to a directory offer. A client
  that does not know it receives an ordinary folder.

The app id is unchanged, so the app meets other clients on the same
server as before.

Chat is different by intent: its messages travel as standard text offers,
but on codes only a paired PortalGems device can derive. Another wormhole
client can never land on one, and would see an ordinary text message if it
somehow did. Nothing about chat changes how transfers interoperate.

## 9. Parked: a fully custom "PortalGemsPlus"

Not for now. Recorded so the ideas are not lost. With a server of our own
making:

- a claim released when its connection drops, which removes leftover
  slots even after a crash;
- a "do any of these slots exist" request, which allows a cheap poll
  without a public list;
- the list switched off, so a stranger cannot find a slot to interfere
  with;
- shorter expiry of abandoned slots.

The price is a fork to maintain and the loss of "works on any wormhole
server".

## 10. Where the server and the maintainer are

Server in Germany, maintainer in Bosnia and Herzegovina.

- **The rules that apply because of who uses the app do not move with the
  server.** The UK, EU and Australian regimes look at where the users
  are. Moving the server changes none of that.
- **What the location does change** is which country's authorities can
  compel the hosting company or seize the machine, and which country's
  law the operator of the server answers to first.
- **Germany** is a defensible place for it: strong secrecy of
  telecommunications, and a regulator whose published guidance leaves
  non-commercial offers outside the messenger category and starts its
  interception duty at 100,000 users.
- **The United States would not obviously be better.** A server there
  brings the US reporting statute and US legal process to bear directly,
  for no gain found so far.
- **Bosnia and Herzegovina:** nothing reliable was found on its rules for
  communication services. This is the gap, and the question for a local
  lawyer before release.
- A maintainer outside the EU offering a service to people inside it is
  within reach of the GDPR; whether a representative in the EU is needed
  for a server that keeps nothing is a question for the same lawyer.

Suggestion: leave the server where it is until someone qualified says
otherwise.

## 11. What is still open

Answered since revision 1: its questions 1, 3, 4, 7, 9, 10, 11 and 12.

1. **A new slot for every message**, numbered by the second, newest only
   (section 2). Agreed as proposed?
2. **The queue rules** (section 4), rule 2 in particular.
3. **The numbers** in section 5.
4. **Polling 5 s / 30 s**, and a measuring step before fixing them
   (section 3).
5. **Does the app poll only while a chat screen is open,** or whenever it
   is in the foreground? The second lets the home screen show that a
   device is writing to you, and is what the first document parked as
   "what is polled".
6. **The role and the limits in the pairing record:** added by the
   rotation work, so the record changes once, or added by chat later? The
   rotation document proposes the first (its section 11).
7. **Symbian's way of sending and receiving at once** (section 7).
8. **Versions**, deferred until before release (5.20).
9. **The disclaimer** shown when chat is switched on, and the guide
   entries, not yet drafted. Revision 1, section 7 has the first draft of
   the explanation screen; it needs "every half minute" changed once the
   polling numbers are fixed.
10. **A lawyer** in Bosnia and Herzegovina before release (section 10).

## 12. Order of work, as it stands

None of this starts until the design is agreed.

1. Fix the `todo!()` in the vendored crate (5.21). Independent of chat.
2. Rotation of the pairing secret, on master, from its own document.
3. The clean release, in the Rust crate and the C client.
4. The `list` poll in the engine, and the measuring step.
5. Chat codes and the pairing record's new fields.
6. The chat itself: desktop and Android, then Symbian.
