# Messaging between paired devices - design, revision 3

Status: **final for step one, agreed 2026-10-12, nothing built** (branch
`messaging`). Section 15 lists what still has to be verified while
building.

This is the consolidated design. It stands on its own for what is to be
built. The reasoning behind each choice, and everything that was
considered and dropped, is in the three earlier documents, kept as
written:

- `docs/MESSAGING-DESIGN.md` - the first plan and the list of what can go
  wrong (its item numbers, such as "5.8", are used below),
- `docs/MESSAGING-DESIGN-REVISION-1.md` - how the mailbox behaves, the
  first draft of the explanation screen, the compliance lists,
- `docs/MESSAGING-DESIGN-REVISION-2.md` - why the server is not patched,
  the queue rules, interoperability.

Where they disagree with this file, this one is right. Rotation of the
pairing secret is designed in `docs/PAIRING-ROTATION-DESIGN.md` and is
built on master before chat.

## 1. What it is

**Two walkie-talkies, not a phone line.** Two paired devices open a chat
with each other and exchange text. It works while both have the chat on
screen. Nothing runs in the background, nothing is delivered to a device
that is not in the chat, nothing is kept, and there are no accounts.

- **Off by default.** Switched on in Settings, which shows a disclaimer
  and a guide: how to use it, the security model, what it does not do.
- **Not on the public server.** Chat needs the PortalGems server or a
  custom one. On the public magic-wormhole server it is disabled, and the
  app says this is deliberate, to keep from overloading a server run by
  volunteers. Every description of the feature says so.
- **Stock servers only.** The mailbox server is not patched or forked.

## 2. Step one

In:

- text between two paired devices, up to 400 characters a message,
- held in memory only,
- a fresh key exchange for every message,
- received and shown without a prompt while the chat is open,
- "sent" shown only when acknowledged, and a retry button on a message
  that failed,
- desktop and Android.

Out, for later: replies, reactions, editing and deleting, disappearing
messages, read receipts, typing indicator (dropped for good), photos,
files, voice notes, links that open, stored history, an outbox across
sessions, an announcement on entering the chat. Symbian gets chat on a
branch of its own taken from this one; nothing here may make that harder.

## 3. How a message travels

### Codes and slots

- A message is sent as the protocol's ordinary text offer, on a code only
  the two paired devices can derive. Nothing new goes on the wire.
- The code is derived from the pairing secret, a label of its own (so a
  chat code can never be a transfer code), **the sender's role**, and
  **the second in which the message is sent**.
- The role is recorded at pairing: the device that showed the code or QR
  is "first", the one that joined is "second". Both can send. The role
  only makes the two directions use different codes, so two people
  sending at once do not meet each other.
- **Every message gets a slot of its own and no slot is used twice.** A
  retry goes out on a new slot. The limit of one message a second is what
  makes "the second" unique.
- Chat slot numbers are 16 digits (transfers use 8), so that a receiver
  holding several hundred candidate codes cannot land on a stranger's
  slot by chance. The Rust crate takes any length and the C client up to
  31 digits; the server's own limit is to be confirmed in the first
  engine step.
- Clocks may differ by 5 minutes either way.

### Sending

1. The message enters the queue. **One message is in flight at a time.**
2. The sender claims the slot and waits for the other device, for up to
   **2 minutes**.
3. Acknowledged: the message shows as sent, and the next one in the queue
   goes at once.
4. Not picked up, or failed for any reason: the message shows as failed
   with a retry button, **and every message queued behind it fails with
   it**, each with its own button.
5. A waiting message can be cancelled; it becomes a failed one.
6. Whenever a wait ends without success, the sender **releases its claim
   cleanly**.

### Receiving

1. While a chat screen is open, the device keeps one connection to the
   server and asks for the list of slots: **every 10 seconds for one
   minute after any message was sent or received, otherwise every 30
   seconds.** Each number is one constant.
2. It computes the codes the other device could be using now - every
   second of the last 2 minutes, plus the clock tolerance - and looks for
   their slots in the list.
3. It joins only **the newest one it finds**. Anything older is a
   leftover.
4. The engine checks the offer **before acknowledging it**: it must be a
   text offer, carry the chat marker, and be within this device's byte
   ceiling. Anything else - a file, a folder, an oversized or unmarked
   text - is refused, so the sender sees a failure and not "sent".
5. A message whose identity was already seen is acknowledged and not
   shown again. That is what makes a retry safe.
6. After a message, the device asks for the list again at once. Only the
   first message of a burst waits for a poll.
7. A slot that was joined and turned out dead is remembered and skipped.
   An attempt on a slot is cut off after 10 seconds, as today.
8. **When the server is slow, the device eases off.** If a poll takes
   more than 3 seconds to answer, the polling interval doubles, up to 2
   minutes, and returns to normal once replies are quick again. Section 9
   shows why: a busy server is otherwise pushed over by its own clients.

Polling stops when the chat screen is left, and when the app leaves the
foreground. A message in flight at that moment is cancelled, released,
and marked failed.

### The message

    PGCHAT1:<identity>:<text>

No nested JSON, so that the Symbian client can read it with what it has.
The `1` is the format's version. The identity is random and chosen by the
sender, and a retry keeps it. No timestamp travels: each device shows its
own time of sending or receiving.

### What the engine gains

- A fix for the `todo!()` that a server can trigger (5.21). Independent of
  chat, and first.
- Release on cancel, in the vendored crate. Paired transfers gain from it
  too.
- A poll: one connection, asked for the list repeatedly, compared against
  a set of codes.
- A chat receive that refuses before acknowledging.

Sending needs nothing new: it is `send_text` on a given code.

## 4. What chat needs from pairing

- **A role and the device's byte ceiling in the pairing record**,
  exchanged at pairing. They are added by the rotation work on master, so
  the record changes once.
- **A pairing made by a version without them cannot chat.** The app says
  so and asks for the two devices to be paired again.
- Because the ceiling is exchanged at pairing, a sender always knows it
  before the first message.
- **Rotation.** On master, every completed paired transfer rotates the
  secret, a text outside chat included. Chat does not rotate on every
  message. It rotates **once per new chat: on the first message that is
  delivered in it.**
- **What "new" means.** Two devices never open a chat at the same
  instant, and one may have been restarted while the other was not. A
  chat is new on a device when it holds no conversation with that peer in
  memory. The first message a device sends or receives in a chat that is
  new on its side asks for a rotation during the handshake, and asking
  means both rotate. Two devices that both start fresh therefore rotate
  once or twice, never per message.
- With rotation a device may hold up to three secrets for a pairing, so a
  receiver computes its candidate codes for each of them.

## 5. The numbers

| What | Value |
|---|---|
| Typed length | 400 characters |
| Byte ceiling, desktop and Android | 2,000 bytes for the whole message |
| Byte ceiling, Symbian | what the phone announces at pairing; 1,000 bytes today |
| Sending | 1 message per second |
| Wait for the other device | 2 minutes |
| Polling | every 10 s for a minute after any message, otherwise every 30 s |
| Easing off | a poll slower than 3 s doubles the interval, up to 2 minutes |
| One attempt on a slot | 10 seconds |
| Clock tolerance | 5 minutes either way |
| Conversation in memory | the last 500 messages per paired device; the oldest drop off and the screen says so |
| Slot number | 16 digits |

All of these are single constants. The ceiling and the 500 may change.

A message too long for the device it is going to is refused at the
sender, before sending, with the reason.

## 6. What a message may contain

Text. Line breaks are kept. Control characters and direction-override
characters are stripped on receipt. Nothing in a message is a link,
nothing is rendered as markup, nothing is fetched. A message can be
copied to the clipboard.

## 7. On the device

- **Memory only.** No message, draft, log line or crash report with
  message text reaches disk. On the desktop nothing goes to localStorage.
- **Forgotten when the app's process ends.** Not on leaving the chat
  screen, not in the background. Conversations with several devices can
  be held at once.
- **Android can end a background app without asking,** and the
  conversation goes with it. The disclaimer says so plainly.
- **The desktop asks once on quit** when conversations are open.
- **Screenshots and the recent-apps preview are blocked in the chat on
  Android.** The desktop is left as it is.
- **Removing a pairing** drops its conversation at once. It is also the
  only block there is, and it is reachable from inside the chat.
- **Chat does not touch the "last used" time** of a paired device. That
  value is written to disk and would record when two people last talked.
- **No notifications** for chat. It only works while it is on screen.
- A transfer and a chat with the same device can run at once.
- A peer with chat switched off, a peer that is not there, and a pairing
  that has fallen out of step all look the same: the message times out.

## 8. The server

- Stock `magic-wormhole-mailbox-server`, as documented in
  `docs/VPS-SETUP.md`.
- **Its slot list stays on.** The poll depends on it.
- **Someone else on a slot (5.11) is accepted.** A stranger who watches
  the list can make one exchange fail, cannot read or forge anything, and
  the retry covers it. It is the one problem left open by not patching
  the server.
- **The database goes on a memory filesystem** (`--channel-db`, an
  ordinary option). Section 9 is why; it also means waiting ciphertext
  never rests on a disk. A restart then loses the slots in flight, which
  costs the people in them one retry. `docs/VPS-SETUP.md` gets the same
  advice for anyone running their own server.
- The "keeps no logs" checks are run again after any change.

## 9. Measurements (2026-10-12)

`scripts/mailbox-load.py` loads a local stock server the way open chats
would: two polling connections per chat, a share of chats with a sender
waiting unanswered, and full message exchanges at a set rate. It speaks
the server's protocol with made-up bodies, so no cryptography is involved.
The file's header says how to run it. It refuses any server that is not
on the same machine.

Run on a laptop (8 cores, of which the server uses one; NVMe disk; server
0.8.0), with no TLS and no Caddy in front. **The figures show the shape,
not what the VPS will do.**

**Messages are the expensive part, and the disk is the limit.**

| Database on | Messages per second | Time per message | Server CPU |
|---|---|---|---|
| disk | 10 | 0.2 s | 35% |
| disk | 20 offered, 10 carried | 20 s and rising | 51% |
| memory | 20 | 0.05 s | 48% |
| memory | 76 | 0.05 s | 82% |
| memory | 200 offered, 38 carried | 17 s and rising | 100% |

On disk the server stalls at about 10 messages a second with half its
processor idle: it is waiting for the disk. In memory it carries about
seven times that before the processor is the limit.

**Polling is cheap until there is a lot of it.** Polling only, every 10
seconds, one chat in ten with a sender waiting:

| Chats | Connections | Polls per second | Typical reply time | Server CPU | Memory |
|---|---|---|---|---|---|
| 1,000 | 2,100 | 200 | 27 ms | 31% | 93 MB |
| 4,000 | 8,400 | 490 of 840 wanted | 5.7 s | 90% | 221 MB |
| 8,000 | 16,800 | 354 of 1,680 wanted | 5.4 s | 99% | 237 MB |

The ceiling is around 400 to 500 polls a second. Every reply carries the
whole list, so the cost of a poll grows with the number of slots in use.

**Both together**, database in memory, every chat polling every 10
seconds and sending 4 messages a minute:

| Chats | Reply time | Time per message | Server CPU |
|---|---|---|---|
| 500 | 2 ms | 0.03 s | 55% |
| 1,000 | 9 ms | 0.07 s | 89% |
| 2,000 | 1.3 s | 16 s | 100% |

With the database on disk the same mix was fine at 100 chats and had
collapsed at 500.

What follows from it:

1. **Put the database in memory.** It is the difference between roughly
   a hundred busy chats and several hundred, for one option on the
   command line.
2. **On this evidence one small server carries some hundreds of chats
   that are all busy at once**, and more that are idle at the 30-second
   poll. That is ample for now and not unlimited.
3. **Overload is not graceful.** Past the limit, exchanges time out, the
   ones that time out leave their slots behind, the list every poll
   returns grows from a few kilobytes to over a hundred, and that slows
   everything further. So the clean release is not a nicety, and clients
   ease off when the server is slow (section 3).
4. The numbers to repeat on the real VPS, through Caddy, before release.

## 10. Tests

Every step of the build ships with its tests. What is wanted in total:

- **Derivation:** chat codes pinned by literal vectors in `packages/core`
  and again in `native/wormhole-mini`, checked against an independent
  implementation, as the pairing codes are. Direction, second, slot
  length, and no overlap with transfer codes.
- **Rules as pure functions in `packages/core`,** each with its table:
  candidate codes and "newest only", the queue (one in flight, fail
  together, cancel, retry keeps the identity), the duplicate filter, the
  message format and its refusals, the limits, the poll timing, the
  stripping of characters.
- **Engine:** unit tests for release on cancel, the poll, and the chat
  receive refusing a file, a folder, an unmarked text and an oversized
  one before any acknowledgement; ignored network round trips for a
  message, a retry and two devices sending at once.
- **A command-line chat example** beside `send` and `recv`, so two
  terminals can talk and a script can drive either end.
- **Desktop smoke modes** for two instances with separate profiles: open
  a chat, send, receive, a peer that is absent, retry, both sending at
  once, leaving and returning.
- **Android:** the pure logic under Jest, which first needs the native
  modules mocked (`docs/BACKLOG.md`); the chat screen driven on a device
  through adb, as the receive flows were.
- **Across platforms:** desktop to Android in both directions over the
  live PortalGems server, and later Symbian.
- **The failure list:** each numbered item of section 5 of the first
  document gets a test or a written reason why it cannot have one.
- **Load:** `scripts/mailbox-load.py`, rerun when the polling numbers or
  the server change.

## 11. Words

- The explanation screen: revision 1, section 7, with "every half minute"
  changed to match the polling above. Liked as drafted.
- Still to draft: the disclaimer shown when chat is switched on; the
  guide entries (`guide.*` in six languages, both guide screens, and the
  Symbian help text when Symbian gets chat); the chat sections of
  `PRIVACY.md` and the README.
- Every string goes into `en.json` first and then all five translations.

## 12. Compliance

Revision 1, section 8 has the lists: what the feature must have, and what
it must never have. Step one needs nothing removed.

- Server in Germany, maintainer in Bosnia and Herzegovina. The server
  stays where it is until someone qualified says otherwise (revision 2,
  section 10).
- **A paid or premium version would weaken the "free and non-commercial"
  position** that the EU classification rests on, for the whole app. Not
  a blocker; a question for the lawyer.
- A lawyer in Bosnia and Herzegovina is consulted before release.

## 13. Deferred, with where it is written down

- Features beyond step one: first document, section 6.
- Versions between releases of chat (5.20): to be settled before the
  branch is released. The format's `1` is already there.
- Symbian: its own branch. Its client does one exchange at a time, so
  sending and receiving at once needs a design of its own (revision 2,
  section 7).
- A custom server, as part of a possible premium product: revision 2,
  section 9.
- Hiding the slot list, a verification string, stored history: first
  document, section 6.

## 14. Order of work

On master first:

1. Fix the `todo!()` in the vendored crate.
2. Rotation of the pairing secret, from its own document, with the role
   and the byte ceiling added to the pairing record.

Then on this branch, one step and one commit at a time, each with its
tests:

3. Release on cancel, in the Rust crate.
4. The poll in the engine, through both bindings.
5. Chat codes and the rules in `packages/core`.
6. The chat receive in the engine; the command-line example.
7. The setting, the disclaimer, and the refusal on the public server.
8. The desktop chat; its smoke modes.
9. The Android chat.
10. The explanation, the guide, `PRIVACY.md`, the README.
11. The load test against the real VPS; the database moved to memory.

Then Symbian, on its own branch.

## 15. Still to verify while building

Nothing here is undecided; these are facts the design assumes and nobody
has checked yet.

1. **The server's limit on the length of a slot number.** The 16-digit
   chat slots depend on it. Checked in the first engine step; if the
   limit is lower, the slot number shrinks to fit.
2. **That other wormhole clients ignore an extra field in the handshake's
   version record,** which the rotation request relies on. Part of the
   rotation work on master.
3. **The measurements on the real VPS, through Caddy,** before release.
4. **The easing-off numbers** (3 seconds, 2 minutes). Starting values, to
   be adjusted against that same test.
