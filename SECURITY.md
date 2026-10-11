# Security

PortalGems exists to move files privately, so a flaw in it matters. If you
find one, thank you - please report it.

## Reporting a vulnerability

Report it privately, so that it can be fixed before it is public:

- Use **Report a vulnerability** on the repository's
  [Security tab](https://github.com/Yenis/portal-gems/security/advisories/new).
  It opens a private conversation with the maintainer.

Please do not open a public issue for something that could put users at
risk. Anything else - a bug, a question, a hardening idea - is welcome as a
normal [issue](https://github.com/Yenis/portal-gems/issues).

A useful report says which app and version, what an attacker needs in order
to do it, and what they gain. A way to reproduce it is the most valuable
part.

PortalGems is maintained by one person in their own time. Reports are read
and answered as soon as that allows, and credited in the changelog unless
you would rather not be named. There is no bug bounty.

## What is covered

- The Android app, the desktop app (Linux, Windows, macOS) and PortalGems
  Mini for Symbian.
- The engine (`native/wormhole-core`), the C client (`native/wormhole-mini`)
  and the pairing scheme (`packages/core/src/pairing.ts`).
- The server setup this project documents in `docs/VPS-SETUP.md`.

The mailbox server, the transit relay and the wormhole protocol itself
belong to the [magic-wormhole](https://github.com/magic-wormhole) project;
flaws there should go to them, though a note here is appreciated if
PortalGems users are affected.

## Supported versions

Only the latest release is supported. A fix is shipped as a new release,
not as a patch to an old one.

## What PortalGems does and does not defend against

The security model is in the [README](README.md#security-model), and the
most recent review of the code, with what it found, is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) under "Security review". In
short:

- Files and messages are encrypted end to end. Connection servers and
  relays see only ciphertext.
- A one-time code can be guessed once; a wrong guess fails the transfer
  where both people can see it.
- It does not defend against someone with control of your unlocked device,
  or against an observer learning that a transfer happened and roughly how
  large it was.
- On Symbian the connection to the server is not transport-encrypted; see
  the README for what that does and does not expose.

## Checking a download

Every release file has a `.sha256` beside it; the README shows how to
check one. The Windows and macOS builds are not code-signed, so the
operating system will warn about them.
