// Sending several files at once.
//
// The wormhole protocol offers one thing per code - a file, a directory or a
// message - so a selection of several is zipped and sent as a directory offer
// marked "loose": a PortalGems receiver unpacks it straight into its receive
// folder, and any other client saves a folder (docs/MULTI-FILE-DESIGN.md).
//
// What lives here is what both apps must decide the same way: which of the
// three send paths a selection takes, what the bundle is called, and how
// "7 files and 2 folders" is put into words.

/** What a picker, a share sheet or a drop hands over. */
export interface PickedItem {
  isFolder: boolean;
}

/**
 * Which send path a selection takes.
 *
 * - `file`, `folder`: exactly one item, sent as it always was - a plain file
 *   offer, or a directory offer with no marker. This is what keeps a single
 *   photo arriving at another client as a photo and not as a folder.
 * - `bundle`: anything more, files and folders mixed included.
 * - `nothing`: an empty selection - a cancelled picker.
 */
export type SendPlan = 'nothing' | 'file' | 'folder' | 'bundle';

export function planSend(items: readonly PickedItem[]): SendPlan {
  if (items.length === 0) return 'nothing';
  if (items.length > 1) return 'bundle';
  return items[0].isFolder ? 'folder' : 'file';
}

/**
 * What a bundle puts into the receive folder: the files and the folders at
 * its top level. A file inside one of those folders is not counted - this is
 * what the receiver will see arrive, and it travels in the offer's marker.
 */
export interface BundleCounts {
  files: number;
  folders: number;
}

export function countBundle(items: readonly PickedItem[]): BundleCounts {
  const folders = items.filter((item) => item.isFolder).length;
  return { files: items.length - folders, folders };
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** One counted noun: `key` for any number, `keyOne` for exactly one. */
function counted(t: Translate, key: 'count' | 'folderCount', n: number): string {
  return t(`files.${n === 1 ? `${key}One` : key}`, { n });
}

/**
 * "7 files and 2 folders", "5 files", "3 folders", "1 file and 1 folder".
 *
 * A kind that is absent is left out rather than counted as zero. The two
 * nouns each exist twice - for exactly one, and for any other number - and
 * that is the whole of the plural handling, on purpose: the languages whose
 * nouns change with the number beyond that (Russian, Bosnian) word the
 * general form so that it does not - "файлы (5)" rather than "5 файлов" -
 * which keeps every language to the same keys and needs no plural rules from
 * the JavaScript engine, which the phone's does not have.
 *
 * Every sentence about a bundle takes this phrase whole, as `{{items}}`, so
 * no sentence has to agree with a number either.
 */
export function itemsText(t: Translate, counts: BundleCounts): string {
  const files = counted(t, 'count', counts.files);
  const folders = counted(t, 'folderCount', counts.folders);
  if (counts.folders === 0) return files;
  if (counts.files === 0) return folders;
  return t('files.both', { files, folders });
}

/** The strings under `files.` that are built around `{{items}}`. */
export type BundleTextKey = 'summary' | 'sending' | 'sent' | 'receiving' | 'saved' | 'savedIn';

/**
 * A sentence about a bundle. The phrase can open the sentence, and in the
 * languages where it starts with a word rather than a digit that word needs
 * its capital - the phrase itself is lower case because it also appears
 * mid-sentence.
 */
export function bundleText(
  t: Translate,
  key: BundleTextKey,
  counts: BundleCounts,
  options: Record<string, unknown> = {}
): string {
  return capitalize(t(`files.${key}`, { ...options, items: itemsText(t, counts) }));
}

function capitalize(text: string): string {
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

const pad = (value: number): string => String(value).padStart(2, '0');

/**
 * The name a bundle travels under: "7 files and 2 folders - 2026-10-10 14.32".
 *
 * A PortalGems receiver never shows it. It is the folder name for everyone
 * else - an older PortalGems, the command-line client - which is why it says
 * what it is and when, in the sender's language and local time, and why it
 * must be a legal file name everywhere: a dot between hours and minutes
 * because Windows refuses a colon, and nothing else Windows refuses either.
 */
export function bundleName(t: Translate, counts: BundleCounts, now: Date = new Date()): string {
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}.${pad(now.getMinutes())}`;
  return sanitizeBundleName(`${capitalize(itemsText(t, counts))} - ${stamp}`);
}

/**
 * Make a string safe to be a folder name on any receiver: no path separators,
 * none of the characters Windows reserves, no control characters, no leading
 * or trailing dots and spaces (Windows drops the trailing ones silently, and
 * a leading dot hides the folder elsewhere).
 */
export function sanitizeBundleName(raw: string): string {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '');
  return cleaned.length > 0 ? cleaned : 'files';
}

/**
 * The line a receiver ends on after a bundle.
 *
 * `saved` is what actually landed in the receive folder - counted there, not
 * taken from the sender's claim - and `expected` is how many top-level items
 * the bundle held. The transfer itself is all or nothing, but that last step
 * is item by item, and a disk that fills during it leaves some behind: then
 * the line says so in numbers instead of claiming either success or failure.
 * `folder` is the chosen download folder's name; without one the items went
 * to the system's Downloads.
 */
export function savedBundleText(
  t: Translate,
  result: { saved: BundleCounts; expected: number; folder?: string | null }
): string {
  const { saved, expected, folder } = result;
  const landed = saved.files + saved.folders;
  if (landed < expected) return t('files.savedSome', { saved: landed, n: expected });
  return folder
    ? bundleText(t, 'savedIn', saved, { folder })
    : bundleText(t, 'saved', saved);
}

/**
 * The name for candidate `n` of a file that must not collide: the name itself
 * for 0, then `name (1).ext`, `name (2).ext`... Only the last dot starts an
 * extension, and a leading dot is a hidden file, not one. The same shapes
 * the engine, the desktop and the C client produce (`create_unique`,
 * `dedupPath`, `wh_numbered_name`), so a clash reads the same wherever it is
 * resolved.
 */
export function numberedFileName(name: string, n: number): string {
  if (n === 0) return name;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

/**
 * Entry names for a bundle of files, from the names their sources report -
 * one per file, in order, no two alike.
 *
 * Used where the app builds the archive itself (Android, from `content://`
 * URIs), so this is that platform's half of what `zip_items_sync` does in
 * the engine:
 *
 * - A name is only ever a name. A provider can report anything, so path
 *   separators and control characters are replaced, and a name that is
 *   empty, missing or all dots becomes `file` - an entry called `..` or
 *   `a/b` must not reach a zip.
 * - Two files of one name are both kept, the later one renamed. Names are
 *   compared without regard to case: `Photo.JPG` and `photo.jpg` are two
 *   files in a gallery and one on a memory card.
 */
export function bundleEntryNames(names: readonly (string | null | undefined)[]): string[] {
  const taken = new Set<string>();
  return names.map((raw) => {
    const cleaned = (raw ?? '')
      // eslint-disable-next-line no-control-regex
      .replace(/[/\\\u0000-\u001f\u007f]/g, '_')
      .trim();
    const name = cleaned.replace(/\./g, '') === '' ? 'file' : cleaned;
    for (let n = 0; ; n++) {
      const candidate = numberedFileName(name, n);
      const key = candidate.toLowerCase();
      if (!taken.has(key)) {
        taken.add(key);
        return candidate;
      }
    }
  });
}

/** One top-level entry of an unpacked bundle, waiting in staging. */
export interface StagedEntry {
  name: string;
  isFolder: boolean;
}

/**
 * Move an unpacked bundle's entries into the receive folder, one at a time,
 * and report what made it.
 *
 * `save` puts one entry where received things go; how is the platform's
 * business. It must never overwrite: a name that is taken is kept beside, as
 * `name (1).ext`, because a bundle's names are only known once it is down -
 * too late to ask.
 *
 * The transfer was all or nothing; this step is not. An entry that cannot be
 * saved (a full disk, mostly) does not stop the others - smaller ones may
 * still fit - and is counted by its absence, so the screen can say "4 of 9"
 * instead of a success or a failure that would both be untrue. Entries go in
 * name order, so the same bundle always lands the same way.
 */
export async function landEntries<E extends StagedEntry>(
  entries: readonly E[],
  save: (entry: E) => Promise<unknown>
): Promise<{ saved: BundleCounts; expected: number }> {
  const ordered = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const saved: BundleCounts = { files: 0, folders: 0 };
  for (const entry of ordered) {
    try {
      await save(entry);
      if (entry.isFolder) saved.folders++;
      else saved.files++;
    } catch {
      // Counted by its absence.
    }
  }
  return { saved, expected: entries.length };
}
