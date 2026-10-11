# Multi-file transfers - design

Status: agreed in discussion on 2026-10-10, not built. This is the plan to
build from; once the feature ships, the lasting parts move into
`ARCHITECTURE.md` and this file becomes historical, like `PLAN.md`.

## 1. What the user gets

- Select several files - in the app's picker, in Android's share sheet, or by
  dropping them on the desktop - and send them as one transfer.
- The receiver is asked once: "5 files - 12 MB", or "7 files and 2 folders -
  40 MB" when folders were sent along. One accept, and all of it arrives.
- The files land directly in the receive folder, next to everything else.
  Send five, then five more, and there are ten files there - not two folders
  of five.
- It works with a one-time code and with a paired device alike.
- A single file is still sent exactly as it is today.

## 2. Why it is built this way

The wormhole transfer protocol (v1) carries one offer per code, and an offer
is a file, a directory or a text message. There is no "several files" offer.
The three ways around that:

| Approach | Verdict |
|---|---|
| Zip the selection and send it under a `directory` offer | Chosen. One accept, works with codes, and every existing client can receive it. |
| One wormhole per file, auto-accepted after the first | Rejected. Paired devices only, a handshake per file, three derived codes per five-minute bucket, and "4 of 7 arrived" becomes a state. |
| Transfer v2 | Rejected. Experimental in magic-wormhole.rs, absent from the Python client, and it would have to be written again in C89 for Symbian. |

Upstream's own answer to multiple files is Dilation and its subchannels,
which is still in development. Until that exists everywhere, a directory
offer is the only interoperable container.

## 3. Wire format

A multi-file send is a standard directory offer with one extra member:

    {"offer": {"directory": {
        "dirname":  "7 files and 2 folders - 2026-10-10 14.32",
        "mode":     "zipfile/deflated",
        "zipsize":  1234567,
        "numbytes": 1300000,
        "numfiles": 23,
        "portalgems": {"loose": true, "files": 7, "folders": 2}
    }}}

- `portalgems.loose` means: these are loose items, unpack them into the
  receive folder itself instead of into a folder called `dirname`.
- `files` and `folders` are how many of each sit at the top level of the
  bundle - what will appear in the receive folder. `numfiles` keeps its
  standard meaning, every file including those inside the folders, so here
  7 loose files and 2 folders holding 16 more make 23.
- The two counts exist so the receiver can be told the truth before it
  accepts: "7 files and 2 folders", not "23 files" followed by seven files
  and two folders. They word a sentence and are not enforced; a marker
  without usable counts is still loose, with `numfiles` standing in for the
  files and no folders assumed.
- It is an object so that later additions have somewhere to go without
  another top-level name.
- A receiver that does not know the member ignores it and saves a folder
  called `dirname`. That is the fallback, and the reason `dirname` is still a
  name worth reading.

Why an extra member is safe:

- Python `wormhole` 0.12.0 reads `mode`, `dirname`, `zipsize`, `numbytes`
  and `numfiles` by name and nothing else (`cli/cmd_receive.py`,
  `_handle_directory`). Checked in the installed copy.
- The vendored Rust crate's `OfferMessage::Directory` has no
  `deny_unknown_fields`, so PortalGems 1.3.5 and older should ignore it too.
  To be confirmed by test against a 1.3.5 build, not assumed (section 9).
- `wormhole-mini` looks members up by name (`wh_json_get`).

The fallback name is what the bundle holds and when:
`7 files and 2 folders - 2026-10-10 14.32`, `5 files - ...`, `3 folders -
...`, in the sender's language and local time. A dot separates hours and
minutes because a colon is not a legal file name character on Windows.

## 4. Sender rules

What is selected decides what is sent. The picker is always multi-select;
the engine path is not.

| Selection | Sent as |
|---|---|
| One file | A `file` offer - today's path, untouched |
| One folder | A `directory` offer with no marker - today's path, untouched |
| Two or more items, or files and folders mixed | A loose bundle |

Keeping one file on the plain file offer matters: it is what the CLI and
every other client expect, and a single photo must not arrive at a
`wormhole receive` as a folder.

Building the bundle:

- Every selected item becomes a top-level entry in the zip. A selected
  folder goes in as a tree under its own name.
- `numfiles` counts files, including those inside selected folders;
  `numbytes` is their total size. The marker's `files` and `folders` count
  the top-level entries only.
- Two top-level items with the same name are renamed inside the zip:
  `name (1).ext`, `name (2).ext`; folders `name (1)`.
- An empty selection sends nothing. A selection that cannot be read fails
  before anything is offered.
- The staged zip is deleted afterwards in every outcome, as for a folder.

### Picking

- One picker, one confirmation, straight to the send screen. The app never
  accumulates a list across several visits to the picker.
- Android: `pick({ allowMultiSelection: true })` for both the generic "Send
  files" and a paired device's Send.
- Desktop: the open dialog with `multiSelections`, for both.
- Symbian: no multi-select picker exists, so it does not send bundles.
  "Send folder" covers the need there.

Picking from one place makes same-name clashes rare, but it does not rule
them out, so the renaming above stays:

- Android's picker can show Recents or search results, which span folders.
- A gallery's share sheet can share from an album that spans folders.
- A desktop drop can come from a file manager's search results.

### Share sheet (Android)

- The manifest gains an `ACTION_SEND_MULTIPLE` filter next to `ACTION_SEND`.
- `MainActivity` parks the list of URIs; `consumePendingShare` returns all
  of them.
- The share target chooser from 1.3.5 is reused and shows "5 files".
- One shared file still takes the single-file path.

### Drag and drop (desktop)

- Several items dropped on a paired device are sent as one bundle. The
  "Drop one file or folder at a time" message goes away.
- Files and folders mixed are allowed; the rules above already cover them.

## 5. Receiver rules

When the offer carries `portalgems.loose`:

- The prompt says what will arrive and asks once: "7 files - 12 MB",
  "7 files and 2 folders - 40 MB", "3 folders - 28 MB". No bundle name is
  shown.
- Nothing is saved until the whole bundle has arrived and unpacked in the
  staging area. A transfer that is cancelled or fails leaves nothing.
- Each top-level entry is then moved into the receive folder. A name already
  taken gets `name (1).ext`; nothing is ever overwritten and nothing is
  asked. The "overwrite or keep both" prompt cannot apply, because the names
  are not known until the bundle is down.
- The success screen says the same phrase: "7 files and 2 folders saved to
  <folder>". It counts what was actually moved into the receive folder, not
  what the sender claimed. Single files and folders keep their current
  wording.
- The zip-slip checks and the unpack size cap apply unchanged.

When the offer has no marker, nothing changes: a folder is a folder.

One honest limit: "all or nothing" describes the transfer. The final move
into the receive folder is file by file, so a disk that fills during it can
leave some files saved. The screen must then say how many were saved, not
claim success or total failure.

Per platform:

- Android: unpack in the app cache as today, then save each entry with the
  call a single received file uses (`saveToDownloads` / `saveToDownloadDir`),
  and a selected sub-folder with the folder call.
- Desktop: `pg:acceptDownload` moves each child of the unpacked directory
  with `dedupPath` instead of moving the directory.
- Symbian: unpack straight into `E:\PortalGems\`. Its single-file receive
  overwrites an existing name today (`RFile::Replace`); a bundle needs a
  small unique-name step so that it keeps both, like the other two.

## 6. Engine and binding changes

- `native/magic-wormhole` (fourth patch, documented in `PORTALGEMS-PATCH.md`):
  `send_zipped_directory` takes the marker; `DirectoryOfferInfo` reports it.
- `native/wormhole-core`:
  - `send_files(paths, bundle_name, ...)` - zips a list of files and folders
    and sends it loose. Used by the desktop.
  - `send_zip_as_folder` gains a `loose` argument. Used by Android, which
    zips from `content://` URIs in Kotlin because Rust cannot read them.
  - `FolderOffer` gains `loose: Option<LooseBundle { files, folders }>`.
  - `accept` is unchanged: it returns the unpacked directory, and the app
    moves the children. The apps already own the "staging to receive folder"
    step, so the flattening belongs there.
- `native/wormhole-node` and `packages/wormhole-rn`: regenerate for the new
  signatures. Mobile: `yarn ubrn:android` (chains `scripts/ubrn-postgen.sh`),
  then `yarn prepare`, then Metro with `--reset-cache`.
- Android Kotlin: `zipUrisToCache(uris, name)` beside `zipTreeToCache`,
  reading each URI once straight into the zip - no intermediate copy.
- `native/wormhole-mini`: `wh_xfer_offer` gains `loose`; the unpack takes a
  destination that may be the receive folder itself.

## 7. Strings and screens

New strings, all six languages:

- Home: "Choose files to send" (replaces the singular).
- The phrase itself - "7 files", "3 folders", "7 files and 2 folders" - from
  two counted nouns and a joiner (`itemsText`). Every sentence below takes
  it whole.
- Send: "Preparing files...", "Sending <phrase>...", "<phrase> sent."
- Receive: "Incoming files", "Do you want to receive these files?",
  "Receiving N files...", "N files saved to <folder>.", and the partial-save
  message from section 5.
- Share chooser: "N files" where it now shows one file's name.
- The bundle's fallback name.

Per CLAUDE.md, the user guide is updated in the same change: `guide.*`, the
two section lists, and Symbian's `KHelpText` (receiving only).

## 8. Documentation and positioning

- README: a feature row and a paragraph, stating plainly that the transfer
  is all or nothing and that both ends need this version for loose files -
  an older PortalGems or another client receives a folder instead.
- CHANGELOG, ARCHITECTURE.md, SYMBIAN.md.

What can be claimed, from a first look at other clients (2026-10-10):

- The Python client, magic-wormhole.rs and wormhole-william each send a
  file, a directory or text. None documents sending several files at once.
  magic-wormhole.rs sends a folder as a tarball the receiver unpacks by
  hand.
- RiftShare (desktop) does zip a multi-file selection and unzips it between
  two RiftShare installs, so "multi-file" alone is not unique.
- Warp and Rymdport were not confirmed either way. Check before the README
  compares against them.

So the claim to make is specific: several files, one confirmation, loose
files on arrival, from a phone's share sheet, and still a standard folder to
every other client. Not "the only client that can send multiple files".

## 9. Tests

This must not regress single-file or folder transfers, so most of the tests
are about what does not change.

Rust (`wormhole-core`), unit:

- Bundle builder: flat files; files and folders mixed; nested trees; empty
  folder kept; `numfiles` and `numbytes` correct.
- Name clashes: two and three same-name files; same-name file and folder;
  a name that already ends in " (1)"; names with and without extensions.
- Refusals: empty selection; a path that vanished; a symlink (skipped, as
  for folders).
- Marker: serialises only when set; parses when present, absent, and beside
  unknown members; the pre-marker struct still parses a marked offer (the
  1.3.5 compatibility check, with the old struct copied into the test).
- Unpack: a loose bundle is subject to the same zip-slip and size-cap
  refusals as a folder.

Rust, end to end (the existing `*_over_public_server` pattern):

- Loose bundle round trip, contents byte-identical.
- Single file still produces a `file` offer; single folder still produces a
  directory offer with no marker.
- Cancel mid-bundle leaves nothing staged.

C (`wormhole-mini`, `make test` and `make test-arm`):

- Offer parsing: marker present, absent, `loose` false, `portalgems` present
  with unknown members, `portalgems` not an object.
- Loose unpack into a directory that already holds the same names.
- `wh-mini` receives a loose bundle sent by `wormhole-core`, on the host.

TypeScript (`packages/core`, vitest) - the decision logic lives here so it
can be tested without a device:

- Selection to send kind: one file, one folder, several files, mixed, empty.
- Fallback name: count, date format, no characters illegal on Windows.
- Prompt and success text for 2 and N files, and the partial-save text.
- Translation completeness (already enforced) covers the new strings.

Interop, scripted against the installed Python `wormhole`:

- `wormhole receive` of a loose bundle yields a folder with the fallback
  name and all the files.
- `wormhole send <dir>` to the new receiver still yields a folder.

Desktop: the receive-side flattening (`dedupPath` over children) as a plain
Node test; a smoke mode for a multi-file send beside the existing ones.

On devices - what no automated test here reaches:

| Case | Android | Desktop | Symbian |
|---|---|---|---|
| Send 2+ files, code | yes | yes | - |
| Send 2+ files, paired | yes | yes | - |
| Share 2+ photos from the gallery | yes | - | - |
| Drop 2+ files, and files with a folder | - | yes | - |
| Receive loose, names free | yes | yes | yes |
| Receive loose, names taken | yes | yes | yes |
| Receive loose twice: N + N files, no folders | yes | yes | yes |
| Receive from a 1.3.5 sender (folder) | yes | yes | yes |
| Send to a 1.3.5 receiver (folder fallback) | yes | yes | - |
| Single file and single folder, unchanged | yes | yes | yes |
| Cancel mid-transfer leaves nothing | yes | yes | yes |

## 10. Build order

One commit each, receive before send so that no build can send what it
cannot receive:

1. Vendored crate patch and `wormhole-core`, with their tests.
2. `packages/core`: selection logic, names, strings, tests.
3. Desktop receive.
4. Android receive (includes the binding regeneration).
5. Symbian receive, `wormhole-mini` tests.
6. Desktop send: picker and drop.
7. Android send: picker.
8. Android share sheet.
9. Guide, README, CHANGELOG, ARCHITECTURE.md, SYMBIAN.md.

## 11. Decided after the first draft

- The marker is `portalgems.loose`. It is the one thing that cannot be
  renamed after release.
- The fallback name's word "files" follows the sender's language.

## 12. Progress

- Step 1 (vendored crate and `wormhole-core`) is built. `send_files` is
  there; `send_zip_as_folder` and `FolderOffer` carry `loose` inside the
  crate, but the UniFFI surface in `ffi.rs` does not expose it yet - that
  changes in step 4 together with the regenerated bindings, so no commit in
  between has bindings that disagree with the library.
- Step 2 (`packages/core`) is built: `files.ts` holds `planSend` (which of
  the three send paths a selection takes), `bundleName`, `filesText` and
  `savedFilesText`, and the `files.*` strings exist in all six languages.
  Nothing uses them yet. Wording that already exists - "Choose file to
  send", the drop hint, the guide - changes in the steps that change the
  behaviour it describes, not here.
- Counts are not left to a plural engine. Every counted string has a `One`
  twin for exactly one file, and Russian and Bosnian word the general form
  so the noun never follows the number ("Файлов: 5"). The phone's JavaScript
  engine has no plural rules to lean on, and this keeps all six languages to
  the same keys, which the completeness test requires.
- Mixed selections changed the wording (decided 2026-10-10, after steps 1
  and 2): the marker carries `files` and `folders`, and every string says
  "7 files and 2 folders" where it said "N files". The engine and
  `packages/core` were reworked for it in one change: `LooseBundle` in the
  vendored crate and the engine, `countBundle`, `itemsText`, `bundleText`
  and `savedBundleText` in core. The `One` twins are now only on the two
  nouns; sentences are built around the phrase.
- On the desktop a mix of files and folders, or several folders, can only
  be dropped. "Choose folder to send" stays a single-folder picker and
  "Choose files to send" picks files - two plain buttons, by decision.
- Step 3 (desktop receive) is built: the addon reports `loose`, main lands
  a bundle through `landBundle`, and the receive screen has the bundle's
  prompt, progress and saved line. `npm test` in `packages/app-desktop` is
  new and covers the landing. Until the apps can send a bundle, the engine
  example can: `cargo run --example send -- --files "<name>" <paths...>`.
- Step 4 (Android receive) is built, and the UniFFI surface now carries the
  bundle: `FolderOfferInfo.loose` and a `loose` argument on
  `send_zip_as_folder`, both `Option<LooseBundleInfo { files, folders }>`.
  The React Native bindings were regenerated with it. `ReceiveScreen` lists
  the unpacked bundle with the new native `listStaged`, saves each item with
  the calls a single file and a single folder already use, and clears what
  is left with `removeStaged`. The loop itself is `landEntries` in
  `packages/core`, where it is tested; the desktop keeps its own in
  `landing.ts` because it moves on disk instead of saving through a
  provider.
- One Android limit, inherited from folder receives: with no download folder
  chosen, files go through MediaStore, which has no directory objects. A
  folder in a bundle whose name already exists in Downloads is therefore
  merged into - its files individually kept beside same-name ones - instead
  of becoming `name (1)`. With a chosen download folder it is `name (1)`,
  as on the desktop.
- `ubrn-postgen.sh` ends in a `git checkout`; when the regeneration is not
  run by the repository's owner, keep a copy of `android/CMakeLists.txt`
  beforehand and put it back by hand instead.
- Step 5 (Symbian receive) is built: `wh_xfer_parse_offer`,
  `wh_numbered_name` and `wh_items_text` in `wormhole-mini` with
  `tests/test_bundle.c` (host and ARM), bundle landing in `wh-mini receive`,
  and `LandBundle` in the Symbian engine. The phone build itself was not
  compiled where this was written - the 32-bit cross compiler could not run
  there - only syntax-checked with a host compiler against the SDK headers,
  so `abld build gcce urel` is the first thing to run.
- Step 6 (desktop send) is built: `send_files` in the addon,
  `describeSelection` in `src/selection.ts` (tested by `npm test`), the
  multi-select picker, any number of dropped items, and the bundle's own
  wording on the send screen. The home button reads "Choose files to send"
  through a new `home.sendFilesButton`; the phone keeps `home.sendButton`
  until its own picker changes in step 7, and `devices.dropOne` is gone.
