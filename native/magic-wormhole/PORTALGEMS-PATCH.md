# Vendored magic-wormhole 0.8.1 - PortalGems patch notes

This directory is a vendored copy of the `magic-wormhole` crate, version
0.8.1, from crates.io (upstream: https://github.com/magic-wormhole/magic-wormhole.rs,
license EUPL-1.2 - see LICENSE). It exists because PortalGems needs
protocol-v1 "directory" offers, which the released crate supports on the wire
but does not expose through its API. The patch is deliberately small and is a
candidate for upstreaming.

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

No other files were modified. Local additions to this directory:
this file. Registry metadata (`.cargo_vcs_info.json`, `Cargo.toml.orig`,
`Cargo.lock`, `.github/`, dotfiles) was not copied.

## Upgrading

To move to a newer upstream release: re-vendor the new version and re-apply
the changes above (they are additive and small). Check first whether upstream
has gained native directory-offer support (issue tracker: transfer-v2 work
may supersede this).
