// Sending several files at once.
//
// The wormhole protocol offers one thing per code - a file, a directory or a
// message - so a selection of several is zipped and sent as a directory offer
// marked "loose": a PortalGems receiver unpacks it straight into its receive
// folder, and any other client saves a folder (docs/MULTI-FILE-DESIGN.md).
//
// What lives here is what both apps must decide the same way: which of the
// three send paths a selection takes, what the bundle is called, and how a
// count of files is put into words.

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

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The strings under `files.` that carry a count, and so have a `One` twin. */
export type FilesCountKey =
  | 'name'
  | 'summary'
  | 'sending'
  | 'sent'
  | 'receiving'
  | 'saved'
  | 'savedIn';

/**
 * A `files.*` string for `n` files.
 *
 * Every counted string exists twice, `key` and `keyOne`, and exactly one file
 * takes the second. That is the whole of the plural handling, on purpose: the
 * languages whose nouns change with the number beyond that (Russian, Bosnian)
 * word the general form so that it does not - "Files: 5" rather than
 * "5 files" - which keeps every language to the same two keys and needs no
 * plural rules from the JavaScript engine, which the phone's does not have.
 *
 * A bundle of one file is rare but real: a file picked together with an
 * empty folder is two items and one file.
 */
export function filesText(
  t: Translate,
  key: FilesCountKey,
  n: number,
  options: Record<string, unknown> = {}
): string {
  return t(`files.${n === 1 ? `${key}One` : key}`, { ...options, n });
}

const pad = (value: number): string => String(value).padStart(2, '0');

/**
 * The name a bundle travels under: "5 files - 2026-10-10 14.32".
 *
 * A PortalGems receiver never shows it. It is the folder name for everyone
 * else - an older PortalGems, the command-line client - which is why it says
 * what it is and when, in the sender's language and local time, and why it
 * must be a legal file name everywhere: a dot between hours and minutes
 * because Windows refuses a colon, and nothing else Windows refuses either.
 */
export function bundleName(t: Translate, fileCount: number, now: Date = new Date()): string {
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}.${pad(now.getMinutes())}`;
  return sanitizeBundleName(`${filesText(t, 'name', fileCount)} - ${stamp}`);
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
 * `saved` is how many of the `total` top-level items made it into the receive
 * folder. The transfer itself is all or nothing, but that last step is item
 * by item, and a disk that fills during it leaves some behind: then the line
 * says so in numbers instead of claiming either success or failure.
 * `folder` is the chosen download folder's name; without one the files went
 * to the system's Downloads.
 */
export function savedFilesText(
  t: Translate,
  result: { saved: number; total: number; folder?: string | null }
): string {
  const { saved, total, folder } = result;
  if (saved < total) return t('files.savedSome', { saved, n: total });
  return folder
    ? filesText(t, 'savedIn', total, { folder })
    : filesText(t, 'saved', total);
}
