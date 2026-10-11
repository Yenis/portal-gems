// What a picker or a drop handed over, turned into what will be sent. Kept
// apart from main.ts, and free of Electron, so that it can be tested as
// plain Node: this decides whether a selection goes out as one file, one
// folder or a bundle, and what the send screen says it is.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { countBundle, planSend, type BundleCounts } from '@portalgems/core';

/** What a selection becomes. `file` and `folder` are sent as they always
 * were; `bundle` is two or more items sent as one transfer. */
export type Selection =
  | { kind: 'file'; path: string; name: string; size: number }
  | { kind: 'folder'; path: string; name: string; fileCount: number; totalBytes: number }
  | {
      kind: 'bundle';
      /** The files and folders to send, each a top-level item. */
      paths: string[];
      /** How many of each: what the receiver is told to expect. */
      counts: BundleCounts;
      /** Every file, including those inside the folders. */
      fileCount: number;
      totalBytes: number;
    };

/** File count and total size of a directory tree (symlinks skipped, matching
 * what the engine will actually zip and send). */
export async function walkStats(
  dir: string
): Promise<{ fileCount: number; totalBytes: number }> {
  let fileCount = 0;
  let totalBytes = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const p = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(p);
      } else if (entry.isFile()) {
        fileCount += 1;
        totalBytes += (await fs.promises.stat(p)).size;
      }
    }
  }
  return { fileCount, totalBytes };
}

/**
 * Describe a selection of paths. Null when there is nothing in it that can
 * be sent, or when any of it cannot be read - a selection is sent whole or
 * not at all, never "most of it".
 *
 * One path is taken as it always was, a symlink followed to what it points
 * at. In a selection of several, a symlink is left out, as the engine leaves
 * it out of the archive: the counts shown here and the counts the receiver
 * is told must be the same numbers. If that leaves a single item, it is sent
 * as that item and not as a bundle of one.
 */
export async function describeSelection(paths: readonly string[]): Promise<Selection | null> {
  try {
    const items: { path: string; isFolder: boolean; size: number }[] = [];
    for (const p of paths) {
      if (!p) return null;
      const stat = paths.length === 1 ? await fs.promises.stat(p) : await fs.promises.lstat(p);
      if (stat.isDirectory()) items.push({ path: p, isFolder: true, size: 0 });
      else if (stat.isFile()) items.push({ path: p, isFolder: false, size: stat.size });
      // A symlink, a socket, a device: nothing that can be sent.
    }

    const plan = planSend(items);
    if (plan === 'nothing') return null;
    if (plan === 'file') {
      const [only] = items;
      return { kind: 'file', path: only.path, name: path.basename(only.path), size: only.size };
    }
    if (plan === 'folder') {
      const [only] = items;
      const stats = await walkStats(only.path);
      return { kind: 'folder', path: only.path, name: path.basename(only.path), ...stats };
    }

    let fileCount = 0;
    let totalBytes = 0;
    for (const item of items) {
      if (item.isFolder) {
        const stats = await walkStats(item.path);
        fileCount += stats.fileCount;
        totalBytes += stats.totalBytes;
      } else {
        fileCount += 1;
        totalBytes += item.size;
      }
    }
    return {
      kind: 'bundle',
      paths: items.map((item) => item.path),
      counts: countBundle(items),
      fileCount,
      totalBytes,
    };
  } catch {
    return null;
  }
}
