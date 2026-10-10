# Vendored magic-wormhole 0.8.1 - PortalGems patch notes

This directory is a vendored copy of the `magic-wormhole` crate, version
0.8.1, from crates.io (upstream: https://github.com/magic-wormhole/magic-wormhole.rs,
license EUPL-1.2 - see LICENSE). It exists because PortalGems needs two
protocol-v1 offer types - "directory" and "message" - which the released
crate supports on the wire but does not expose through its API. The patches
are deliberately small and are candidates for upstreaming.

## Why

The wormhole file-transfer protocol v1 has a `directory` offer type
(`{"offer":{"directory":{dirname, mode:"zipped", zipsize, numbytes,
numfiles}}}`) - it is what the Python reference client sends for
`wormhole send <dir>`. It is the only interoperable way to tell a receiver
"this payload is a zipped folder, unpack it" as opposed to "this is a zip
file the user chose to send".

Stock 0.8.1 behavior:

- `transfer::send_folder` does NOT use the directory offer; it streams an
  uncompressed tar and offers it as a regular *file* named `<name>.tar`.
- On receive, a directory offer is flattened into a file offer named
  `<dirname>.zip`; the `numfiles`/`numbytes` metadata and the fact that it
  was a folder are discarded before reaching the caller.

## The patch (vs. crates.io 0.8.1)

`src/transfer/v1.rs`:

- The body of `send_file` was factored into a private `send_blob` that takes
  the offer `PeerMessage` as a parameter; `send_file` is now a thin wrapper.
- New `pub(crate) send_zipped_directory`: sends a caller-provided zip stream
  under a `directory` offer (`mode: "zipfile/deflated"` - the only mode the
  Python reference implementation emits or accepts; note upstream's own test
  fixture says "zipped", which Python rejects).
- `request` now preserves directory-offer metadata in a new public
  `DirectoryOfferInfo { dir_name, num_files, num_bytes }` carried by
  `ReceiveRequest` (accessor: `directory_offer()`). Directory modes other
  than "zipfile/deflated" are rejected as `UnsupportedOffer` (previously the
  mode was ignored).
  The synthesized `<dirname>.zip` file name and `file_size() == zipsize`
  behavior are unchanged, so existing callers are unaffected.

`src/transfer.rs`:

- New public `transfer::send_zipped_directory(...)` wrapper.
- `pub use v1::DirectoryOfferInfo`.

## The second patch: text messages

The protocol has always had a `message` offer
(`{"offer":{"message":"..."}}`), and 0.8.1 can even serialize one - the
constructors `offer_message_v1` and `message_ack_v1` exist, marked
`#[allow(dead_code)]`, because nothing reaches them. PortalGems needed text
on every platform, so they are now wired up.

`src/transfer/v1.rs`:

- New `pub(crate) send_message`: sends the offer and waits for
  `{"answer":{"message_ack":"ok"}}`. It negotiates **no transit at all**.
  This is not an optimization, it is the protocol: the reference sender
  builds a `TransitSender` only when there is a file, so a receiver that
  volunteers a transit message to a text sender reaches
  `ts.add_connection_hints(...)` with `ts = None` and crashes it with an
  `AttributeError`. The read loop tolerates a stray transit message anyway,
  because the reference implementation's own loop does.
- `request` now reads the peer's **first** message before sending anything,
  and branches on it: a transit message means a file or folder is coming, an
  offer on its own means the payload is that message. Upstream sent its
  transit message unconditionally and then demanded one back, which can only
  ever work for file transfers. Reading first is also what the reference
  receiver does - it sends transit only in reply to transit.
- `request` returns the new public `IncomingOffer { File(ReceiveRequest),
  Text(String) }`. A text offer is acknowledged and the wormhole closed
  before it is handed back, so there is nothing left to accept.
- New `request_file_only`, the old signature, for callers that cannot act on
  a text offer; it reports one as `UnsupportedOffer`.
- `cancel::debug_err` became `pub(crate)` so the text path can close its
  wormhole the same way every other path does.

`src/transfer.rs`:

- New public `transfer::send_message(...)` and `transfer::request_offer(...)`.
- `transfer::request_file` now delegates to `v1::request_file_only`, so its
  signature and behaviour are unchanged for existing callers.
- `pub use v1::IncomingOffer`.

Verified in both directions against the Python reference client (`wormhole
send --text` / `wormhole receive`), including multi-line and non-ASCII text,
and file transfers were re-checked through the reordered receive path.

No other files were modified. Local additions to this directory:
this file. Registry metadata (`.cargo_vcs_info.json`, `Cargo.toml.orig`,
`Cargo.lock`, `.github/`, dotfiles) was not copied.

## The third patch: a panic when the peer leaves mid-handshake

`src/transit/transport.rs`, in `wrap_tcp_connection`:

```rust
peer_addr: socket.peer_addr().expect("Internal error: socket must be IP"),
```

became `socket.peer_addr()?`.

Nothing guarantees the peer is still there when transit finishes negotiating.
If the other side cancels - or its own attempt is cut short - the socket is
already gone, `peer_addr` fails with `ENOTCONN`, and stock 0.8.1 panics in
whatever worker thread it happens to be on. That is reachable from ordinary
use: it fires every time a pairing handshake is interrupted while transit is
coming up. Returning the error instead costs nothing, because the connection
is dead either way and every caller already handles a transit failure; a
panic crossing the FFI is a far worse outcome, and on Android worse still.

Observed as `Panic in async function` through the napi addon before the fix.

## The fourth patch: the loose marker on a directory offer

PortalGems sends several files in one transfer by zipping them and offering
the archive as a `directory` - the only container protocol v1 has. To tell a
receiver that the archive is a selection of loose files and not one folder,
the offer carries one extra member:

    {"offer":{"directory":{"dirname":...,"mode":"zipfile/deflated",
        "zipsize":...,"numbytes":...,"numfiles":...,
        "portalgems":{"loose":true}}}}

A receiver that does not know it ignores it and saves a folder called
`dirname`: the Python client reads the five standard members by name, and
this crate's `OfferMessage` has never denied unknown fields. The design and
its reasoning are in `docs/MULTI-FILE-DESIGN.md`.

`src/transfer/v1.rs`:

- `OfferMessage::Directory` gains `portalgems: Option<serde_json::Value>`,
  defaulted on read and omitted on write when `None`, so an unmarked offer
  serialises byte for byte as before. It is a raw value on purpose: a
  malformed or newer extension must never make an otherwise valid directory
  offer fail to parse.
- New `loose_marker()` and `directory_is_loose()`: the one place that writes
  the member and the one place that reads it. Only an object with
  `"loose": true` counts.
- `send_zipped_directory` takes `loose: bool`; `DirectoryOfferInfo` gains
  `loose: bool`.

`src/transfer.rs`:

- `offer_directory_v1` and the public `send_zipped_directory` take `loose`.
- Tests: the marked offer pinned byte for byte
  (`test_offer_directory_loose`), every shape the member can arrive in
  (`test_offer_directory_loose_parsing`), and the pre-extension enum parsing
  a marked offer (`test_offer_directory_loose_is_ignored_by_old_receivers`) -
  the proof that an old receiver degrades to a folder instead of failing.

## Upgrading

To move to a newer upstream release: re-vendor the new version and re-apply
the changes above. The directory-offer changes are additive and small; the
text-message change to `request` reorders the first two messages, so re-read
that function rather than pattern-matching the diff. Check first whether
upstream has gained native directory-offer or message support (issue tracker:
transfer-v2 work may supersede both).
