# Messaging between paired devices - plan

Status: **planning, nothing built** (started 2026-10-12, branch
`messaging`). No code is to be written until the plan and the design are
agreed in full. This file holds what has been agreed, what can go wrong,
and every point that was raised and set aside, so that none of it has to be
rediscovered. Sections 1 and 2 are the agreed part; everything after is
open.

Nothing here has been tested. The statements about the engine, the vendored
crate and the mailbox server come from reading their source; the statements
about law come from public guidance and secondary sources and are not legal
advice.

## 1. What it is

Two paired devices open a chat with each other and exchange text. It is not
a messenger that is always on: nothing runs in the background, nothing is
delivered to a device that does not have the chat open, and there are no
accounts. Two walkie-talkies, not a phone line.

The approach is to go in small steps, and to design each one by asking
first how it fails.

## 2. Step one - agreed scope (2026-10-12)

The smallest thing that is a chat:

- **Text only.** No files, photos, voice notes or links that open.
- **Memory only.** Nothing is written to disk. Leaving the chat forgets the
  conversation, on both devices independently.
- **No replies, no reactions, no typing indicator, no read receipts.**
- **Every message is its own key exchange.** A message is sent exactly as
  "send text to a paired device" sends one today: a fresh wormhole, a fresh
  SPAKE2 handshake, one message, close. No connection and no key outlives
  one message.
- **The one difference from today's send-text flow:** once both devices
  have entered the chat, an incoming message is taken and shown by the app
  itself, without the user confirming each one.
- **Foreground only.** The chat works while it is on screen. No background
  polling, no foreground service, no notifications for chat.
- **Speed is not a goal.** A delay of several seconds per message is
  acceptable.

Rejected for step one, on purpose: one long-running encrypted session for
the whole conversation (section 4 says why).

## 3. How the keys work, and why per-message exchange

What the protocol does today, for any wormhole:

- The two devices run SPAKE2 with the code as the password. That gives one
  256-bit master key for that wormhole.
- Each message is encrypted under its own key, derived as HKDF(master key,
  sender side, message number), with XSalsa20-Poly1305 and a random nonce
  (`derive_phase_key` in `native/magic-wormhole/src/core/key.rs`). The keys
  differ per message, but whoever holds the master key can derive them all.
- The master key exists only in memory, for as long as the wormhole is
  open.

For a paired device the code is derived from the 32-byte pairing secret, so
it cannot be guessed, and the handshake is as strong as that secret.

What a fresh exchange per message gives:

- Each message has an independent key that exists for a second or two.
  Reading one device's memory at one moment yields at most the message in
  flight, not the conversation.
- Published proofs say SPAKE2 is forward secret: a pairing secret stolen
  later should not open messages recorded earlier. Caveat: only the
  abstracts were read, and the strongest result is for SPAKE2 with key
  confirmation. Whether wormhole's `version` message counts as that
  confirmation is an interpretation, not a checked fact.
- The server holds a message's ciphertext for seconds: the mailbox deletes
  its messages when both sides close.

What it does not give:

- **The pairing secret stays the one thing everything rests on.** Whoever
  copies it can impersonate either device from then on, in any design
  discussed so far. Only pairing again fixes that. (A secret that moves
  forward after each use was discussed and parked - section 6.)
- Someone who controls an unlocked device reads the screen. No key
  schedule helps with that.

## 4. Why not one long session

Considered first, and dropped:

- One master key in memory for the whole conversation, and the server
  storing the whole conversation's ciphertext until the session ends.
- `magic-wormhole.rs` cannot reconnect a dropped wormhole. Dilation, the
  protocol's layer for durable connections, was not finished in Rust as of
  the last status found (April 2025).
- A session is one long wait, so it needs the liveness check the engine
  does not have (`docs/BACKLOG.md`, "A connection lost while waiting goes
  unnoticed").
- The crate does not put incoming messages in order
  (`Wormhole::receive`, "TODO maybe reorder").
- Symbian's client does one exchange at a time; a session with sending and
  receiving interleaved is a different program.

Short exchanges avoid all five: a failed one is simply tried again.

## 5. What can go wrong

The list to design against. Each entry is a problem, not yet a decision,
unless it says so.

### Meeting

1. **Both send at the same moment.** Today's derived code does not depend
   on direction. Two senders on one code complete the handshake with each
   other, both send an offer, both wait for an answer, and both fail.
   Transfers rarely collide; a chat will. The code needs the direction in
   its derivation, which needs something that tells the two devices apart.
   What that is has not been settled.
2. **Chat and transfers must not meet.** A chat message must never turn up
   on the ordinary Receive screen, and a file must never be taken by the
   chat's automatic receive. A separate label in the derivation keeps the
   codes apart, and the chat must decline anything on its code that is not
   a chat message, a file or folder offer above all.
3. **"Both have entered the chat" has to be known somehow.** The agreed
   behaviour depends on it, and nothing tells one device that the other
   opened the chat. Either the first message just waits until it is picked
   up, or entering the chat announces itself. Open - the first thing to
   settle in the design.
4. **The other device is not in the chat.** The sender claims its code and
   waits for nobody. It must give up after a bounded time and say so.
5. **A sender that gives up leaves its claim behind.** The server keeps it
   until it is pruned (10 to 20 minutes) or the time bucket rolls over
   (5 minutes). This is the open backlog item "The stale claim is never
   released". In a chat it would happen every time someone writes to an
   absent peer, so the clean release - a patch to the vendored crate - is
   very likely a prerequisite.
6. **Three codes per bucket is not enough for a chat.** A send that does
   not finish moves the next one to the next of three codes
   (`PAIRED_CODE_ATTEMPTS`); after three failures in five minutes there is
   no code left until the bucket rolls over. Fine for transfers, tight for
   a conversation.
7. **A crash releases nothing.** Even with a clean release, a killed app
   leaves its claim. The receiver's attempt on such a code is already
   bounded at 10 s (`PAIRED_ATTEMPT_TIMEOUT_MS`), which is also 10 s in
   which nothing else is received.
8. **Polling as it is done today is heavy.** A paired receive tries up to
   nine codes, each a separate TLS connection. Repeating that every 10 to
   15 seconds for as long as a chat is open is a lot for a phone and for
   the server. The server's `list` command names every active meeting slot
   in one request and leaves no claim behind (the crate already uses it in
   `MailboxConnection::connect` when `allocate` is false). A probe built on
   it would make a poll one small request. Proposed, not agreed.
9. **Clocks.** Codes come from five-minute buckets, with one bucket of
   tolerance either way. Two devices further apart than that never meet.
   True of paired transfers today; a chat makes it visible as "cannot
   reach".
10. **Different servers.** Two devices set to different connection servers
    never meet. Also true today.
11. **Someone else on the slot.** Slot numbers can be listed by anyone, and
    anyone can join one. They cannot complete the handshake, but they can
    make that exchange fail. More exchanges, more chances. A nuisance, not
    a breach.

### Delivery

12. **The acknowledgement is lost.** The receiver has the message, the
    sender believes it failed and sends it again. Each message needs an
    identity so that a repeat is dropped, not shown twice.
13. **"Sent" must mean acknowledged.** The protocol's own reply
    (`message_ack`) is the only evidence that the other device has the
    message. Nothing is to be shown as delivered before it.
14. **Order.** With one exchange per message and retries, messages can
    arrive out of order. Step one has no replies to lean on; a per-sender
    counter would at least let a gap or a swap be shown.
15. **The app leaves the foreground in the middle of a send.** Android may
    cut the connection. The message is then neither sent nor failed until
    something says so.
16. **The network drops in the middle of an exchange.** Same question: what
    does the sender see, and is the message tried again or handed back.

### Taking messages without asking

17. **The pairing handshake is today the only thing accepted without a
    prompt**, and it is capped and checked (`isHandshakeOffer`). Chat adds
    a second. It needs its own limits: a length cap, a rate limit, a cap on
    how much conversation is kept in memory.
18. **A message is text and nothing else.** No clickable links, no link
    previews, no rendering of markup; control characters and
    direction-override characters stripped or shown harmlessly.
19. **A paired device can misbehave.** Pairing means "I know this device",
    not "this device is well behaved": a flood of messages, a message at
    the size limit over and over, or a different version of the app
    sending fields this one does not know.
20. **Versions.** A peer without chat never answers. A peer with a newer
    chat sends something this version cannot read. The message format
    needs a version from the first day, and unknown fields must be
    ignored, as the pairing payload does.

### The server

21. **A hostile or broken server** can drop, delay and reorder; it cannot
    read or forge. It can also crash the engine: `Wormhole::receive` in the
    vendored crate reaches a `todo!()` when a message's phase is not a
    number (`native/magic-wormhole/src/core.rs`). Read from the code, not
    tried. It affects transfers today too and should be fixed regardless.
22. **Load on a server that is not ours.** Chat multiplies the number of
    exchanges. Whether chat is offered at all on the public magic-wormhole
    server is undecided (section 6).

### The device

23. **Memory only is a promise.** Nothing of a conversation may reach
    disk: no draft saved, no log line, no crash report with message text,
    and on the desktop nothing left in localStorage.
24. **What the user is told.** Leaving the chat loses the conversation and
    anything unsent. That has to be clear before it happens, not after.
25. **Screens are visible.** Screenshots, the Android recent-apps preview,
    the clipboard. Whether to block the first two is undecided.
26. **One side removes the pairing.** The other keeps writing to nobody.
    Removing a paired device is also the only "block" there is.

### Symbian

27. **A message must fit one 2 KB phase message**, and the typed limit
    there is 400 characters (`docs/SYMBIAN.md`, "Text messages"). Either
    the chat's limit is the same everywhere or it differs per peer.
28. **One thing at a time.** The client does one exchange and waits for
    it. Polling for messages while the user types is new ground there.
29. Whether Symbian gets chat in step one, later, or not at all is
    undecided.

## 6. Set aside, to come back to

Raised in discussion and deliberately not part of step one.

**Features**

- Replies. Wanted later; they also settle which message answers which
  when delivery is slow.
- Reactions, editing, deleting for both sides, disappearing messages. All
  possible, all cooperative: the other device's app has to honour them.
- Delivered and read receipts beyond the plain "sent".
- Typing indicator - dropped. It makes no sense with slow delivery.
- Photos, taking a picture from the chat, files, voice notes. Would go as
  ordinary transfers announced inside the chat, never through the mailbox.
- An outbox: write now, deliver when both next have the chat open.
- Search and export, which only mean something with stored history.
- Not possible without a backend: delivery to an absent device, push,
  "ringing" the other device, history shared across several devices,
  cloud backup, groups (a mailbox holds two sides).
- Link previews: possible, and to be refused. Fetching one tells a third
  party the address.
- Voice and video calls: out of scope.

**Design choices**

- One exchange per batch instead of per message - three quick messages as
  one handshake. Cheaper for the server; step one stays per message.
- Who waits. Step one follows today's flow: the sender claims the code and
  the receiver polls. The other way round - the receiver waits on an open
  connection and the sender joins - delivers at once, but brings back a
  long-lived connection and the liveness problem.
- What is polled. One `list` request could check every paired device at no
  extra cost, so the home screen could say that a device has a message
  waiting while the app is open. The alternative is to poll only inside an
  open chat.
- A pairing secret that moves forward after each exchange, so that a
  stolen copy stops working. Parked: if the two sides fall out of step the
  pairing is broken.
- A verification string per pairing (already "undecided" in the backlog).

**Storage and the privacy promise**

- `PRIVACY.md` says the app keeps no history of transfers, and 1.4.3
  removed a "last transfer" line for that reason. Step one keeps the
  promise. Stored history, if it ever comes, changes it and would be
  opt-in; at-rest protection is good on Android and weak on a Linux
  desktop without a keyring (`ARCHITECTURE.md` section 7).
- `PRIVACY.md`, the README and the in-app guide (six languages, three
  apps) all need a chat section before release.

**Servers**

- Whether chat is allowed on the public magic-wormhole server. It is
  someone else's volunteer resource.
- Keeping the PortalGems mailbox's database in memory (tmpfs), so that
  ciphertext waiting in a slot never rests on a disk. Not tried.
- Re-running the "server keeps no logs" checks in `docs/VPS-SETUP.md`
  after any change made for chat.

**Compliance** - a summary of the research, to be redone before release

The laws looked at regulate whoever provides a service. There are two
roles here: publisher of the software, and operator of the default
connection server. "No servers" is not accurate - every chat message
passes through the mailbox as ciphertext. Chat also moves the app from
"file transfer tool" into the category these laws name: messenger.

- **UK, Online Safety Act.** One-to-one messaging over the internet is not
  among the exemptions (email, SMS/MMS and one-to-one voice are). The
  provider is whoever controls who can use the service, falling back to
  individuals. Whether that describes this project is unclear; duties
  also need links with the UK, such as a significant number of UK users.
- **EU, electronic communications code.** Messengers are
  "number-independent interpersonal communications services". The German
  regulator's guidance (July 2025) sets no minimum number of users for
  the classification, reads "for remuneration" broadly, and excludes
  offers outside a commercial context; its interception duty starts at
  100,000 users. Low exposure for a free project, arguable, not certain.
- **EU, the CSAM regulation ("chat control").** Not adopted. The trilogue
  of 29 September 2026 reportedly reached no agreement on private
  messages; not confirmed from an official source. To be watched.
- **EU, GDPR and the DSA.** Addresses at the server are personal data
  already; chat adds no new kind. The DSA would treat the relay as a
  "mere conduit" if it applies at all.
- **Australia, Online Safety Act.** The Relevant Electronic Services
  standard covers messaging offered to users in Australia. An encrypted
  service need not weaken its encryption, but must be able to show why
  detection is not feasible and take "alternative action". No exemption
  for small providers was found.
- **Australia, Assistance and Access Act.** "Designated communications
  provider" reaches suppliers of software. Notices may not require a
  "systemic weakness". Nothing was found on open-source developers.
- **United States.** CALEA excludes information services. Reporting of
  CSAM is triggered by actual knowledge, with no duty to monitor. The
  STOP CSAM Act was pending, not law, when checked.
- **Stores.** Google Play asks apps with user content for a way to report
  and to block; removing a paired device is the block. F-Droid has no
  such rule.

What speaks for the project everywhere: no discovery, no strangers, no
groups, no public content, and contact only after a code or QR code has
been exchanged out of band.

Not known, and it decides which of these matters first: where the
maintainer and the server are located.

## 7. Open questions, in the order they block step one

1. How does a device know the other has entered the chat (5.3)?
2. What tells the two devices apart, for direction-specific codes (5.1)?
3. Polling: today's code-by-code attempts, or a `list` probe (5.8)? And
   how often?
4. Is the clean release of a claim built first, as a prerequisite (5.5)?
5. What happens to a message whose send did not finish: tried again
   automatically, or handed back to the user (5.15, 5.16)?
6. The limits: message length, messages per minute, conversation kept in
   memory (5.17, 5.27).
7. The message format and its version field (5.12, 5.14, 5.20).
8. Symbian in step one or later (5.29)?
9. Chat on the public server, yes or no (5.22)?

## 8. Sources

- Perfect Forward Security of SPAKE2 - https://eprint.iacr.org/2019/1194
- Forward secrecy of SPAKE2 - https://eprint.iacr.org/2019/351
- Magic-Wormhole client protocol -
  https://magic-wormhole.readthedocs.io/en/latest/client-protocol.html
- Magic-Wormhole server protocol -
  https://magic-wormhole.readthedocs.io/en/latest/server-protocol.html
- Magic-Wormhole known attacks -
  https://magic-wormhole.readthedocs.io/en/latest/attacks.html
- Magic-Wormhole ecosystem (Dilation status) -
  https://magic-wormhole.readthedocs.io/en/latest/ecosystem.html
- Mailbox server source -
  https://github.com/magic-wormhole/magic-wormhole-mailbox-server
- Online Safety Act 2023, section 226 -
  https://www.legislation.gov.uk/ukpga/2023/50/section/226
- Online Safety Act 2023, Schedule 1 -
  https://www.legislation.gov.uk/ukpga/2023/50/schedule/1
- Bundesnetzagentur, guidance on NI-ICS (July 2025) -
  https://www.bundesnetzagentur.de/SharedDocs/Downloads/DE/Sachgebiete/Digitales/OnlineKom/NICS/Guidance_NIICS.pdf
- Chat control tracker - https://brusselsrecord.com/chat-control-tracker/
- eSafety, Relevant Electronic Services standard fact sheet -
  https://www.esafety.gov.au/sites/default/files/2024-06/Fact-sheet-registration-RES-Standard.pdf
- eSafety, statement on end-to-end encryption -
  https://www.esafety.gov.au/newsroom/media-releases/statement-on-end-to-end-encryption-and-draft-industry-standards
- Telecommunications Act 1997 (Cth), section 317ZG -
  https://classic.austlii.edu.au/au/legis/cth/consol_act/ta1997214/s317zg.html
- 18 U.S.C. 2258A -
  https://www.govinfo.gov/content/pkg/USCODE-2023-title18/html/USCODE-2023-title18-partI-chap110-sec2258A.htm
- STOP CSAM Act of 2025 -
  https://www.congress.gov/bill/119th-congress/senate-bill/1829/text
- Google Play, user-generated content policy -
  https://support.google.com/googleplay/android-developer/answer/9876937
