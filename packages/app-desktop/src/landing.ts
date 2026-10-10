// Getting a finished transfer out of its staging directory and into the
// download folder. Kept apart from main.ts, and free of Electron, so that it
// can be tested as plain Node: this is the step that decides what the user
// finds in their folder, and what name it has.

import * as fs from 'node:fs';
import * as path from 'node:path';

/** First free `name`, `name (1)`, `name (2)`, … inside `dir` (engine
 * convention). Folder names never get extension-split (`my.stuff (1)`). */
export function dedupPath(dir: string, name: string, isFolder = false): string {
  const dot = isFolder ? -1 : name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let dest = path.join(dir, name);
  for (let n = 1; fs.existsSync(dest); n++) {
    dest = path.join(dir, `${stem} (${n})${ext}`);
  }
  return dest;
}

/** Move across filesystems if needed; lands at `dest` via an atomic rename.
 * Handles both files and directories (a received folder is a directory). A
 * copy that fails part-way takes its partial copy with it. */
export async function moveEntry(src: string, dest: string): Promise<void> {
  try {
    await fs.promises.rename(src, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    const part = `${dest}.pgpart`;
    try {
      const st = await fs.promises.stat(src);
      if (st.isDirectory()) {
        await fs.promises.cp(src, part, { recursive: true });
      } else {
        await fs.promises.copyFile(src, part);
      }
      await fs.promises.rename(part, dest);
    } catch (copyError) {
      await fs.promises.rm(part, { recursive: true, force: true }).catch(() => undefined);
      throw copyError;
    }
    await fs.promises.rm(src, { recursive: true, force: true });
  }
}

/** What became of a bundle: how many files and folders reached the download
 * folder, out of how many top-level items it held. */
export interface BundleLanding {
  files: number;
  folders: number;
  expected: number;
}

/**
 * Move the contents of an unpacked loose bundle into `destDir`: each
 * top-level entry lands beside whatever is already there, files as files and
 * folders as folders, so that five files received twice are ten files and
 * not two folders of five.
 *
 * Nothing is ever overwritten or merged. A name that is taken becomes
 * `name (1).ext` - a folder `name (1)` - because the names in a bundle are
 * not known until it has arrived, which is too late to ask about them.
 *
 * The transfer itself was all or nothing; this step is item by item. One
 * item that cannot be moved (a full disk, mostly) does not stop the rest -
 * smaller ones may still fit - and the counts returned say what happened, so
 * the screen can report "4 of 9" instead of a success or a failure that
 * would both be untrue.
 */
export async function landBundle(stagedDir: string, destDir: string): Promise<BundleLanding> {
  const entries = (await fs.promises.readdir(stagedDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() || entry.isDirectory())
    // A stable order, so that which of two clashing names gets the " (1)"
    // does not depend on the filesystem's mood.
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const landing: BundleLanding = { files: 0, folders: 0, expected: entries.length };
  for (const entry of entries) {
    const isFolder = entry.isDirectory();
    try {
      await moveEntry(
        path.join(stagedDir, entry.name),
        dedupPath(destDir, entry.name, isFolder)
      );
      if (isFolder) landing.folders++;
      else landing.files++;
    } catch {
      // Counted by its absence.
    }
  }
  return landing;
}
