# Messaging between paired devices - plan, revision 1

Status: **planning, nothing built** (2026-10-12, branch `messaging`).

This revises `docs/MESSAGING-DESIGN.md`, which is kept as it was written.
Item numbers such as "5.8" refer to that file. Where the two disagree, this
one is right. It records the decisions made on the first read-through,
answers the questions that came out of it, and lists what is still open.

As before: nothing here has been tested. Statements about the engine, the
Symbian client and the mailbox server come from reading their source, and
the statements about law are not legal advice.

One correction to the first document: a claim nobody released lives on the
server for 11 to 16 minutes (the server expires after 11 minutes without
activity and checks every 5), not "10 to 20".

## 1. Decisions so far

How the feature is described: **two walkie-talkies, not a phone line.**

| Item | Decision |
|---|---|
| Chat is off by default | Switched on in Settings. Switching it on shows a disclaimer and a guide: how to use it, the security model, what it does and does not do. |
| 5.2 Chat and transfers must not meet | Agreed, without exception. |
| 5.3 Knowing the other entered the chat | The first message simply waits until it is picked up. An announcement on entering may come later. |
| 5.4 The other device is not there | The sender gives up after 2 minutes and says so. |
| 5.8 Polling | Every 30 seconds to begin with. The interval is one constant, changed in one line. |
| 5.9 Clocks | Accepted as it is. |
| 5.10 Different servers | Accepted; the user is told how it behaves. |
| 5.12, 5.13 Lost acknowledgement, "sent" | A message counts as sent only when acknowledged. A failed message gets a **retry button** of its own. |
| 5.14 Order | Accepted for now; replies will settle it later. |
| 5.15, 5.16 App leaves the foreground, network drops | The message is marked failed on the sender, with the retry button. |
| 5.17, 5.27 Size | 400 characters for everyone, to begin with. |
| 5.18 Text and nothing else | Agreed. Clickable links perhaps later. |
| 5.19 Misbehaving peer | The sender is limited to one message per second. |
| 5.20 Versions | Noted, not now. To be settled before the branch is released. |
| 5.21 The `todo!()` in the vendored crate | To be fixed. |
| 5.22 Public server | No chat on the public server at all. Chat needs the PortalGems server or a custom one, and every description of the feature says so. |
| 5.23 Memory only | Yes - for as long as there is no stored history. |
| 5.24, 5.25, 5.26 | Agreed. |
| 5.28 Symbian does one thing at a time | Agreed. |
| 5.29 Symbian | Symbian must have chat. It is a selling point. |
| Section 6, set aside | Stays as it is, to be discussed later. |

Two notes on these:

- **5.10:** nothing was found in the code that stops pairing on the public
  server; the derived codes work there as anywhere. So "no chat on the
  public server" has to be enforced by the app - the chat is unavailable
  while that server is selected - not assumed.
- **5.19:** a limit on the sender protects against accidents, not against
  a modified app. The receiving side needs its own bounds (section 6).

## 2. How the mailbox behaves

The question: if messages are stored on the devices only, why does the
mailbox hold messages at all, and several of them?

A mailbox is a meeting slot for two devices, and "message" in the server's
vocabulary is not a chat message. Delivering **one** chat message takes
about six small protocol messages through the slot:

| # | From | What it is | Readable by the server? |
|---|---|---|---|
| 1 | each side | `pake` - its half of the key exchange | Yes, by design. It is a public value; the key cannot be worked out from the two halves without the code. |
| 2 | each side | `version` - proves both arrived at the same key | No, encrypted |
| 3 | sender | the offer - here, the chat message itself | No, encrypted |
| 4 | receiver | the answer - "got it" | No, encrypted |

Why the server keeps them instead of only passing them along: the two
devices are almost never connected at the same instant. The sender arrives,
posts its half of the key exchange, and waits. The receiver may turn up
thirty seconds later. The server has to hold what the first device said
until the second one comes to collect it. That is all the "storing" is: a
few hundred bytes, waiting for the other half of a conversation between
two programs.

When both sides say they are done, the server deletes the slot and
everything in it. If one side never says so - a crash, a dropped
connection - the server removes the slot by itself after 11 to 16 minutes.

So for a chat message that is picked up: the encrypted message sits on the
server from the moment the handshake completes until the receiver answers,
which is a second or two. For a message nobody picks up, the encrypted
message **never reaches the server**: the sender cannot encrypt before the
other side has done its half of the key exchange, so only the public `pake`
value waits there.

## 3. Rotating the pairing secret

The observation is right, and it is wider than chat: a copy of the pairing
secret lets its holder pose as either device for every future paired
transfer. That is true of any scheme built on one long-lived shared
secret. Two things limit it today - the secret sits in protected storage,
and someone able to read it can usually read the device's files as well -
but neither is an answer.

**Can the pairing change every time a transfer succeeds? Yes.** How it is
done matters:

- **Deriving the next secret from the current one alone does nothing.**
  If the next secret is `hash(current)`, a thief holding a copy computes
  the same next secret, and the one after.
- **Mixing in something the thief does not have works.** Every completed
  exchange produces a fresh session key that only the two devices in that
  exchange know. If the next secret is derived from the current secret
  **and** that session key, then a thief who merely holds a copy and was
  not in the exchange cannot follow. One successful transfer between the
  real devices and the stolen copy is dead.
- **It also detects use of the copy.** If the thief uses the copy first
  and completes an exchange with one device, that device moves forward
  with the thief and the real partner is left behind. The next real
  transfer fails, and the app can say: this pairing is no longer in step,
  pair again. Today that would go unnoticed.

**What "falling out of step" means, and why it was parked.** Both devices
must move to the new secret at the same moment, and there is no such thing
over a network. Example: the phone sends a file, the laptop receives it and
moves to secret 2, and the laptop's "got it" is lost on the way. The phone
believes the transfer failed and stays on secret 1. The two now derive
different codes and never meet again.

The usual cure is to never throw the old secret away until the other side
has proved it holds the new one: each device keeps "current" and "next",
tries both, and drops the older only after an exchange succeeds on the
newer. That closes the lost-acknowledgement case. What remains:

- **A restored device.** A profile copied to a new laptop, or a restored
  backup, holds an old secret. Today it keeps working; with rotation it is
  out of step and must pair again. Arguably correct - a restored copy is
  exactly what a stolen copy looks like - but users will meet it.
- **More codes to try.** Two secrets double the receiver's candidates.
- **Three implementations.** `pairing.ts`, the Rust engine (which must hand
  out a value derived from the session key) and the Symbian client, which
  writes `pairs.txt` on a phone that can lose power mid-write.
- **Old versions.** A device that does not know rotation must still pair
  and transfer with one that does, so it has to be negotiated, as the
  message handshake was.

Assessment: worth doing, and the most delicate change the project could
make to its most protocol-critical file. It is not part of chat. Proposed:
its own design document and its own branch, decided separately (open
question 11).

## 4. The three items that needed explaining

### 5.5 A sender that gives up leaves its claim behind

To wait for a receiver, the sender tells the server "I am on slot
12345678". That is a *claim*. The polite way to leave is to tell the
server "I release it". The engine cannot do that today: when a send is
cancelled or times out, the connection is simply dropped, and the server
is not told. It keeps the claim, assuming the sender might come back,
until it expires 11 to 16 minutes later.

Why that hurts: a slot holds two devices. Suppose the sender timed out and
tries again in the same five-minute bucket, so on the same code and the
same slot. The server now counts the dead first attempt as one device and
the new attempt as the second. The receiver arrives as the **third** and
is turned away ("crowded"). The send fails although both people did
everything right.

### 5.6 Three codes per bucket

That is what the three codes are for. Each five-minute bucket has codes
0, 1 and 2. After a send that did not finish, the next send uses the next
code, and so a fresh slot. But there are only three: after three sends
that did not finish inside five minutes, no clean slot is left until the
bucket rolls over.

For file transfers that is plenty. In a chat, "the other person is not
there" is an everyday event, and with the 2-minute timeout each one would
use up a code.

**The cure for both is the clean release.** If a sender that gives up
tells the server so, the slot is freed at once, the same code can be used
again, and the next message is back on code 0. The three codes then only
have to cover the case below. The catch: releasing on cancel needs a
change inside the vendored `magic-wormhole` crate (`docs/BACKLOG.md`,
"The stale claim is still never released"), and the same in the Symbian
client, which is our own code and should be the easier of the two.

### 5.7 A crash releases nothing

A clean release is something the app does on its way out. An app that is
killed - by Android, by a flat battery, by a crash - does nothing on its
way out. Its claim stays for 11 to 16 minutes. This cannot be fixed, only
routed around, and the three codes already do that: up to three crashes in
five minutes are absorbed.

One side effect for the receiver: when it polls and finds such a dead
slot, it joins and waits for a handshake that never comes. That wait is
already cut off at 10 seconds (`PAIRED_ATTEMPT_TIMEOUT_MS`), but for those
10 seconds nothing else is received.

## 5. Options where a choice is needed

### 5.1 Both send at the same moment

This is not a rare race. A sender sits on its code for up to 30 seconds
waiting for the other side's next poll. If the other person presses send
inside that window, both devices are on the same code as senders, they
meet each other, and both fail. So "let it fail and retry" is not an
option; the two directions need different codes. The choices are how the
devices tell themselves apart:

| | How | Cost |
|---|---|---|
| A | **Role recorded at pairing.** The device that showed the code or QR is "first", the one that joined is "second". Each direction's code includes the sender's role. | Simple and exact. Existing pairings have no role stored (`PairedDevice` has none), so they need B or pairing again. Symbian's `pairs.txt` gains a field. |
| B | **Settle the roles on first chat.** Both devices meet once on a shared code - here meeting each other is the point - and the one with the lower connection id becomes "first". Stored from then on. | Works for existing pairings without pairing again. One extra exchange, a new engine function, and a first chat that cannot start until both have been there once. |
| C | **Handle the collision inside the wormhole.** Two offers cross; each side takes the other's and acknowledges it. | No roles at all. A real change to the send path in both engines, and the hardest to test. |

Recommended: A for new pairings. For existing ones, either B or "pair
again to use chat" - open question 1.

### 5.11 Someone else on the slot

It cannot be prevented inside the protocol: the server lets any client
join any slot. What can be done:

| | How | Cost |
|---|---|---|
| A | **Accept it.** The stranger cannot read or forge anything; the exchange fails and the retry button covers it. The same exposure exists for every transfer today. | None. |
| B | **Stop the server listing its slots.** The mailbox has a `--disallow-list` flag. Without the list a stranger has to guess an 8-digit slot number. | Our own receivers use that list today (the crate checks it before joining), so the crate needs a patch, and a polling method built on the list (5.8) becomes impossible. Custom servers would have to do the same. |
| C | **Limit connections per address at the server** (in Caddy). | Server-side only. Slows a nuisance down, does not stop it. |

Recommended: A for step one, and B kept in mind as later hardening - but
note that B and a `list`-based poll exclude each other (open question 2).

### 5.4 The 2-minute timeout - what goes with it

Two minutes is fine: at one poll every 30 seconds it gives the other side
four chances. Suggested alongside it:

- **One message in flight at a time.** Messages written while one is
  waiting queue up behind it, in order.
- **If the head of the queue times out, the queued ones fail with it.**
  Otherwise five messages to an absent peer take ten minutes to fail.
- **Drain without waiting.** After a message is received, the receiver
  polls again at once, and the sender sends the next at once. Otherwise
  one-message-per-exchange plus a 30-second poll means one message per 30
  seconds. With this rule only the first message of a burst waits for the
  poll.
- **Two visible states on a message before "sent":** waiting for the other
  device, and failed with the retry button. A way to cancel a waiting
  message.

### 5.15 and 5.16 Failure in the middle

Agreed: mark the message failed and offer retry. Two details make that
safe:

- **The retry sends the same message, with the same identity.** If the
  failure happened after the message arrived but before the "got it" came
  back, the receiver already has it. It must drop the repeat, and still
  acknowledge it, so that the sender's copy turns to "sent".
- **Leaving the foreground cancels on purpose.** The app stops polling,
  cancels the message in flight with a clean release, and marks it failed.
  On return it polls again. Whether the conversation is still there after
  a spell in the background is open question 4.

## 6. Limits

- **400 characters is not enough of a rule by itself.** The Symbian client
  holds a received text in a 1000-**byte** buffer (`WH_TEXT_MAX`), and a
  character is one byte in English, two in Cyrillic, three in Chinese, and
  four for most emoji. The chat message also carries its identity and
  framing. So: 400 characters as typed, **and** a byte ceiling on the
  whole message that fits Symbian, checked on every platform before
  sending. A message of 400 Chinese characters would be refused at the
  sender with a clear reason.
- **What Symbian does with a longer message:** it does not cut it off. The
  receive fails as a whole, no acknowledgement is sent, and the sender
  sees a failed message. (Read from `wh_xfer_await_offer`; not tried.)
  With the ceiling above enforced by every sender, this can only come from
  a modified client.
- **Sender:** one message per second (decided).
- **Receiver**, which cannot trust the sender's limit: refuse anything over
  the byte ceiling, take one exchange at a time, and cap the conversation
  held in memory, dropping the oldest. The numbers are open question 6.

## 7. The explanation screen - first draft

For the chat's own "How it works" page, in the manner of the app's
existing one. Plain English first; the other five languages follow once
the wording is agreed. Titles and bodies, one card each:

**Two walkie-talkies, not a phone line**
Chat works while both of you have it open. There is no inbox on a server
somewhere holding messages for later. If the other device is not in the
chat, your message waits for two minutes and then tells you it was not
delivered.

**How a message gets there**
When you pair two devices, they agree on a secret that only those two
know. For every message, both devices use it to work out the same meeting
point on the connection server, without telling anyone. Your device goes
there and waits. The other device looks in every half minute. When they
meet, they agree on a brand-new key, the message crosses under that key,
and the key is thrown away. The next message starts from nothing.

**Why there is no account**
An account exists so that a company can find you and hold your messages
until you are online. PortalGems does neither. The two devices find each
other with the secret from pairing, and a message is only ever handed
directly from one open chat to the other.

**What the server sees**
The connection server is a meeting place, not a post office. It sees that
two devices met and for how long. It cannot read a message, and it has
nothing to keep: a message that is picked up passes through in a second
or two, and a message that is not picked up never leaves your device.

**Nothing is kept**
The conversation lives in the app's memory while the chat is open. It is
not written to your device and not stored anywhere else. Close the chat
and it is gone, on your side. What the other person does with what they
read is up to them.

**Which server**
Chat needs the PortalGems server or your own. It is switched off on the
public magic-wormhole server, which is run by volunteers for file
transfers and should not carry a conversation's worth of traffic.

**What this does not protect against**
Someone who can see your screen can read it. Someone with your unlocked
device can open the chat as you. A copy of the pairing secret lets its
holder pretend to be one of the devices - if a device is lost, remove its
pairing on the other. An observer of the network can tell that the two
devices were talking, though not what was said.

Not yet drafted: the disclaimer shown when chat is switched on, and the
guide entries (`guide.*`, the Symbian help text).

## 8. Compliance - what the feature must have, and must not have

First, the limit of this list. No set of features makes an app "fully
compliant" in four jurisdictions at once: whether several of these laws
apply to this project at all is unsettled (section 6 of the first
document), and the answer depends partly on where the maintainer and the
server are, which is still not known. What follows is the set of things
that, on my reading, either the rules ask for or the project's position
depends on. Before release it deserves an hour with a lawyer in the
maintainer's own country.

**Must have**

| | Why |
|---|---|
| A way to block: "Remove this device", reachable from inside the chat | Asked for by Google Play of any app with user content; the natural safety control everywhere. |
| A stated contact for complaints and legal requests, in About and in the repository | The DSA asks intermediaries for a point of contact; regulators and stores expect one. `SECURITY.md` covers vulnerabilities only. |
| `PRIVACY.md` updated for chat before release | What passes through the server, that nothing is stored, that the operator cannot read it. It must stay true. |
| Short terms of use: what the feature is for, that it may not be used for illegal content | Google Play asks for them; the UK and Australian rules assume them. |
| A written note of why content cannot be inspected, and what is done instead | The Australian standard lets an encrypted service off detection only if it can show why it is not feasible and what it does as an alternative. The alternatives here are the block, the contact, and the design itself. |
| A short written risk assessment kept in the repository | The UK Act asks in-scope services for an illegal-content risk assessment and records. Whether this project is in scope is unclear; a two-page honest assessment is cheap either way. |
| The server keeps no logs, and that is re-checked after every change | Already the rule (`docs/VPS-SETUP.md`). Chat makes it matter more. |
| The existing "not directed at children" statement kept | Already in `PRIVACY.md`. |

**Must not have - each of these is what would put the project in a
heavier category**

| | Why |
|---|---|
| Finding or contacting people you have not paired with: search, directories, invitations by link, contact suggestions | "No strangers" is the strongest fact the project has in every regime. |
| Groups, channels, broadcast, anything public | The same, and most duties scale with reach. |
| Messages, history or backups held on the server | It would make the operator a store of communications, with everything that follows. |
| Accounts, phone numbers, any identifier registered with the server | Likewise. |
| Analytics, telemetry, any record of who talked to whom | It would contradict the privacy page and create data that can be demanded. |
| Anything paid: adverts, subscriptions, a paid tier | The EU telecoms classification turns on "provided for remuneration"; a free, non-commercial project is the position to keep. |
| Link previews | They send the address to a third party. |
| A way for the operator to read or scan messages | It cannot be offered without breaking the encryption, and no rule examined requires it today. |

**Nothing in step one has to be removed.** Text only, between two paired
devices, kept nowhere, is the lowest-exposure form the feature can take.

**To be looked at again when they come up:** photos and files inside a
chat (images are what these laws are mostly about; the app already moves
files, but a chat makes it a messenger that moves images), stored history,
and the EU's CSAM regulation if it is adopted.

## 9. What is still open

Answered since the first document: its questions 5 (failed message -
retry button), 8 (Symbian - yes) and 9 (public server - no).

Still to decide, roughly in the order they block the design:

1. **Telling the two devices apart** (section 5): role recorded at pairing
   for new pairings - and for existing ones, settle roles on first chat,
   or pair again?
2. **How a poll is done.** Today's method tries up to nine codes, each its
   own connection, every 30 seconds. A probe built on the server's `list`
   command is one small request - but rules out ever switching the list
   off (5.11, option B). Recommended: the `list` probe.
3. **Is the clean release built first**, as a prerequisite, in the
   vendored crate and in the Symbian client? Recommended: yes.
4. **When exactly is the conversation forgotten:** on leaving the chat
   screen, on leaving the app, or only when the app is closed? And is it
   still there after a spell in the background?
5. **The queue rules** in section 5 (one in flight, fail together, drain
   without waiting, cancel) - agreed as proposed?
6. **The numbers:** the byte ceiling per message, and how many messages a
   conversation keeps in memory.
7. **A peer with chat switched off** looks exactly like a peer that is not
   there: the message times out. Good enough, or should "chat is off"
   be told apart? Telling it apart needs the announcement that was put
   off.
8. **Symbian's shape.** It does one exchange at a time, so while it waits
   to send it is not receiving. Alternate between the two? And what does
   a chat look like on that screen?
9. **Screenshots and the recent-apps preview.** Block them in the chat on
   Android? The desktop cannot do it reliably on Linux.
10. **The message format.** It needs an identity from the first day, for
    the retry. A version field is one more entry and costs nothing now;
    recommended despite "not now". The handling of versions stays
    deferred.
11. **Rotation of the pairing secret** (section 3): its own project? Before
    chat, after, or not?
12. **Where the maintainer and the server are located**, for section 8.

Likely first steps once these are settled, none of them chat yet and each
useful by itself: fix the `todo!()` (5.21), then the clean release.
