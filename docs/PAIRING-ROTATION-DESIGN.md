# Rotating the pairing secret - design

Status: **first draft for discussion, nothing built** (2026-10-12). No code
until the design is agreed. The rules in section 6 are a draft and have not
been verified; section 10 says how they are to be. Section 14 records what
was decided after this draft was written and takes precedence over the
sections it names.

## 1. The problem

Pairing gives two devices one 32-byte secret, and it never changes. Every
paired transfer derives its one-time code from that secret and the clock
(`packages/core/src/pairing.ts`). So anyone who obtains a copy of the
secret - from a stolen or copied profile, a backup, malware, a device sold
without being wiped - can, for as long as the pairing exists:

- pose as either device to the other,
- pick up a paired transfer meant for one of them, by being first on the
  code,
- send a file or message that arrives as if from the paired device.

Nothing tells the two real devices that this is happening. The only cure
today is to remove the pairing and pair again, which nobody does without a
reason.

What already limits it: the secret is in protected storage (Android
keystore; the operating system's keychain on the desktop, where there is
one), and whoever can read it can usually read the device's files too.
Recorded past transfers stay closed even with the secret, because each
used its own key exchange. Neither is a reason to leave it.

## 2. What rotation should achieve

- **A stolen copy stops working by itself.** After the two real devices
  have completed a transfer or two, the copy is useless, without anyone
  doing anything.
- **Using a stolen copy has a cost for the thief.** If the copy is used,
  the real devices end up out of step with each other instead of carrying
  on as if nothing happened.
- **No pairing is ever broken by an ordinary failure:** a lost
  acknowledgement, a cancelled transfer, a crash, a flat battery.
- **Devices that do not know rotation keep working** with devices that do.

Not goals:

- Protecting against someone who holds the device, unlocked, now. They
  have the current secret.
- Protecting against a thief who sits in the middle of **every** exchange
  from the moment of the theft. They can follow each rotation. Missing a
  single exchange locks them out.

## 3. The idea

Deriving the next secret from the current one alone is worthless: a thief
with a copy computes the same next secret, and the one after.

Every completed wormhole produces a session key that only the two devices
in that exchange know. It comes out of the key exchange, not out of the
pairing secret, and someone merely holding a copy of the secret cannot
work it out, even having recorded the traffic. So:

    next secret = HMAC-SHA256(current secret,
                              "portalgems-rotate-v1" || value from session key)

where the value is derived from the wormhole's session key under a label
of our own (the crate exposes the key for exactly this: `Wormhole::key`,
"can be used to derive sub-keys"). A thief who was not in that exchange
cannot follow.

## 4. Why it is hard

The two devices must move to the new secret together, and over a network
there is no "together". Whatever message ends the exchange can be lost,
and then one side believes the transfer finished and the other does not.
Example: the phone sends a file; the laptop receives it and moves on; its
"got it" is lost; the phone thinks the transfer failed and stays. They now
derive different codes and never meet again.

No protocol removes this. It can only be absorbed: a device that is unsure
which secret the other is on keeps both until it finds out. All of the
design is in getting that exactly right, through every lost message and
every crash.

## 5. The two rules everything must obey

1. **A device never sends on a secret unless it has evidence the other
   device holds it.**
2. **A device never forgets a secret the other might still send on.**

A design that keeps both can never break a pairing through an ordinary
failure. A design that breaks either can.

## 6. Two ways to do it

### A. Store before proceeding

Both devices compute the candidate next secret as soon as the handshake
completes, and **store it before any payload moves**. Then a completed
transfer is evidence: if the payload arrived, the sender had stored the
candidate first; if the acknowledgement arrived, so had the receiver.

Draft rules (unverified). A device holds up to three secrets for a
pairing - `old`, `base`, `candidate` - sends on `base`, and looks for the
other device on all three:

- **Handshake completes on a secret H.** `base` becomes H, `candidate`
  becomes next(H, session key), replacing any earlier candidate. Stored
  before anything else happens.
- **The transfer completes.** `old` becomes `base`, `base` becomes
  `candidate`, `candidate` is cleared.
- Anything else - cancelled, declined, failed, crashed - changes nothing
  further.

What that gives: after one completed transfer the thief's copy can no
longer receive anything; after a second it cannot send either.

What it needs: the engine must let the app store between the handshake and
the payload, on both sides, for every kind of paired transfer. Today it
does not. A send runs from code to completion in one call, and a received
text is acknowledged inside the engine before the app sees it
(`native/magic-wormhole/PORTALGEMS-PATCH.md`, "A text offer is
acknowledged and the wormhole closed before it is handed back"). So the
engine's paired calls would be split in two: open and hand back the value,
then carry on. The same in the Symbian client, which is sequential and
should find it easy.

### B. Announce, then adopt

The candidate is computed and stored whenever convenient, and not used.
At the **next** handshake each device says, inside the encrypted part of
the handshake, which candidate it holds. Only when both announce the same
one do they adopt it.

What that gives: correctness does not depend on when anything is written
to disk. What it costs: the copy dies one exchange later than in A, there
are more states to get right, and both engines must carry an extra field
in the handshake.

### Leaning

A, because it has fewer states and locks a copy out sooner. But neither
has been checked, and the choice should be made by the model in section
10, not by preference.

## 7. Which exchanges rotate

- Every completed paired transfer, in either direction: file, folder,
  several files, text.
- Not a transfer over a typed one-time code. That involves no pairing.
- The pairing handshake itself: open. It is the first exchange on the
  secret and could be the first rotation.
- A planned chat feature would complete many exchanges a minute. Whether
  it rotates on each, or at most once per some interval, is open: every
  rotation is a chance to exercise the hard cases.

## 8. Devices that do not know rotation

A pairing only rotates when both devices have said they can. The wormhole
handshake already carries an application version record that each side
sends the other, encrypted; a field there announces rotation. Until both
have announced it in the same exchange, the secret stays as it is, and a
device on an older version notices nothing.

That would let existing pairings start rotating at their first transfer
after both devices are updated, without pairing again. To be confirmed:
that the Python reference client and other wormhole clients ignore an
extra field there, as the protocol says they should.

## 9. What can go wrong

1. **Out of step looks exactly like "not there".** If two devices ever do
   end up on different secrets, each simply never finds the other: a paired
   send times out, as it does when the other device is switched off. There
   is no error to show. Options: suggest pairing again after several
   failures in a row; or keep a separate value from the original pairing,
   used for nothing but letting two devices tell each other "we are out of
   step" - which a thief could use to raise false alarms and nothing more.
   Open.
2. **A restored or copied device.** A profile restored from a backup, or
   copied to a new computer, holds an old secret. Today it keeps working.
   With rotation it is out of step and must pair again. That is correct -
   it is what a stolen copy looks like - but users will meet it, and item
   1 decides whether they understand it.
3. **The write itself.** The stored secret must change in one step, never
   half-written: a temporary file and a rename on the desktop
   (`paired-devices.bin`), one commit on Android, and on Symbian a
   replacement of `pairs.txt` that survives the battery coming out.
4. **A crash between the handshake and the write** (approach A). The
   device comes back without the candidate while the other has it. Rules 1
   and 2 must cover it; the model must show they do.
5. **More codes to look for.** A receiver checks every code of every
   secret it holds: up to three secrets where there is one today, each
   with nine codes. With today's one-connection-per-code polling that
   triples the worst case. Likely order: `base`, then `candidate`, then
   `old`.
6. **Three implementations.** `packages/core` (the rules, shared by the
   desktop and Android), the Rust engine (the value from the session key,
   and the split calls) and `native/wormhole-mini` in C. The rules and
   their test vectors must be identical in TypeScript and C, as the code
   derivation already is.
7. **Someone holding the copy uses it first.** They complete an exchange
   with device A; A moves on with them. Depending on which secret A still
   holds, the real device B either pulls A back into step - dropping the
   thief - or is left out of step (item 1). Both are acceptable outcomes;
   neither is silent success for the thief for long.
8. **Clock, attempts and buckets** are untouched: rotation changes which
   secret goes into the derivation, not the derivation.

## 10. How it is to be verified

Before any app code: a model of the rules as a pure state machine in
`packages/core`, with a test that plays every sequence of events for
several exchanges - transfer completes, acknowledgement lost, cancelled
before the payload, crash before the write, crash after it, on either
device, in either direction - and asserts after each one that:

- the two devices still share at least one secret that one of them sends
  on and the other looks for (rule 1 and rule 2 held), and
- a copy taken at any point stops being accepted within a stated number of
  completed exchanges.

If draft A fails the model, the rules change or B is taken. The same
sequences then become test vectors for the C implementation.

## 11. Riding along

The pairing record changes for rotation, so two things a planned chat
feature needs could be added in the same change, to avoid changing the
record twice. Proposed, not decided:

- **A role**, fixed at pairing: the device that showed the code or QR is
  "first", the one that joined is "second". It lets later features derive
  different codes for the two directions.
- **Limits the device announces at pairing**, such as the longest text it
  can receive (Symbian's buffer is 1000 bytes).

## 12. Open questions

1. Approach A or B - after the model.
2. What the user sees when a pairing is out of step (9.1).
3. Does the pairing handshake count as the first rotation?
4. How often a chat would rotate.
5. Is `old` dropped only by the rules, or also after some time?
6. Do the role and the limits ride along (section 11)?
7. Symbian: in the first version of rotation, or after the other two?

## 13. Likely order of work

1. The model and its tests (section 10). Decide A or B.
2. The engine: the value from the session key, and whatever the chosen
   approach needs of the calls. Both bindings.
3. `packages/core`: the stored record, the rules, the candidate order.
4. Desktop, then Android: storage and the paired flows.
5. `native/wormhole-mini` and the Symbian app, against the same vectors.
6. Privacy page, explainer and guide: what pairing now does, and what a
   restored device will see.

## 14. Decided since the first draft (2026-10-12)

Settled while the chat feature was being designed on the `messaging`
branch (`docs/MESSAGING-DESIGN-REVISION-3.md` there). Recorded here
because that branch's documents are not on master.

- **Rotation is built on master first,** for every paired transfer. Chat
  builds on it afterwards.
- **Every completed paired transfer rotates,** a text included (section
  7).
- **The role and the byte ceiling do ride along** (section 11, open
  question 6). The pairing record gains both in this work, so it changes
  once. The role is "first" for the device that showed the code or QR and
  "second" for the one that joined. The ceiling is the longest text the
  device can receive: 2,000 bytes on the desktop and Android, 1,000 on
  Symbian today.
- **Pairings made before this work have no role.** Chat will refuse them
  and ask for the devices to be paired again. Whether rotation itself
  needs a new pairing, or can start on an existing one as section 8
  suggests, is still open.
- **Chat will not rotate on every message** (open question 4). It rotates
  once per new chat, when either device asks for it during the handshake,
  and asking means both rotate. So the mechanism must support two modes:
  rotate always, as transfers do, and rotate only when one side asks.
- **Before this work, and independent of it:** the `todo!()` in the
  vendored crate's `Wormhole::receive`, which a server can trigger by
  sending a message whose phase is not a number.

Still open: questions 1, 2, 3, 5 and 7 of section 12, and the maintainer's
own comments on this draft, which have not been discussed yet.

