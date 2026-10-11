// What a picked or dropped selection becomes: one file, one folder, or a
// bundle. Plain Node, no Electron - see `npm test`.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { describeSelection, walkStats } from '../selection';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-selection-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Create a file of `size` bytes and return its path. */
const file = (rel: string, size = 1): string => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(size, 7));
  return p;
};

/** Create a folder holding files of the given sizes and return its path. */
const folder = (rel: string, sizes: number[] = []): string => {
  const p = path.join(root, rel);
  fs.mkdirSync(p, { recursive: true });
  sizes.forEach((size, i) => file(path.join(rel, 'sub', `${i}.bin`), size));
  return p;
};

describe('describeSelection', () => {
  it('keeps one file a plain file', async () => {
    const p = file('one/photo.jpg', 1234);
    assert.deepEqual(await describeSelection([p]), {
      kind: 'file',
      path: p,
      name: 'photo.jpg',
      size: 1234,
    });
  });

  it('keeps one folder a plain folder, with its contents counted', async () => {
    const p = folder('one/album', [10, 20, 30]);
    assert.deepEqual(await describeSelection([p]), {
      kind: 'folder',
      path: p,
      name: 'album',
      fileCount: 3,
      totalBytes: 60,
    });
  });

  it('bundles several files', async () => {
    const paths = [file('a.jpg', 100), file('b.jpg', 200), file('c.jpg', 300)];
    assert.deepEqual(await describeSelection(paths), {
      kind: 'bundle',
      paths,
      counts: { files: 3, folders: 0 },
      fileCount: 3,
      totalBytes: 600,
    });
  });

  // 2 loose files and 2 folders holding 3 + 2 more: "2 files and 2 folders"
  // on screen, 7 files in all on the wire.
  it('bundles files and folders mixed, counting top level and total apart', async () => {
    const paths = [
      file('a.jpg', 100),
      folder('album', [10, 20, 30]),
      file('b.jpg', 200),
      folder('other', [1, 2]),
    ];
    assert.deepEqual(await describeSelection(paths), {
      kind: 'bundle',
      paths,
      counts: { files: 2, folders: 2 },
      fileCount: 7,
      totalBytes: 363,
    });
  });

  it('bundles several folders, an empty one included', async () => {
    const paths = [folder('one', [5]), folder('hollow')];
    assert.deepEqual(await describeSelection(paths), {
      kind: 'bundle',
      paths,
      counts: { files: 0, folders: 2 },
      fileCount: 1,
      totalBytes: 5,
    });
  });

  it('keeps the order things were given in', async () => {
    const paths = [file('z.txt'), file('a.txt'), file('m.txt')];
    const picked = await describeSelection(paths);
    assert.equal(picked?.kind, 'bundle');
    assert.deepEqual(picked?.kind === 'bundle' ? picked.paths : null, paths);
  });

  it('keeps two same-named files from different folders as two items', async () => {
    const paths = [file('camera/IMG_1.jpg', 10), file('screens/IMG_1.jpg', 20)];
    const picked = await describeSelection(paths);
    assert.deepEqual(picked, {
      kind: 'bundle',
      paths,
      counts: { files: 2, folders: 0 },
      fileCount: 2,
      totalBytes: 30,
    });
  });

  it('returns null for an empty selection', async () => {
    assert.equal(await describeSelection([]), null);
    assert.equal(await describeSelection(['']), null);
  });

  // Sent whole or not at all: one unreadable item fails the selection
  // rather than quietly sending the rest.
  it('returns null when anything in the selection is gone', async () => {
    const here = file('here.txt');
    assert.equal(await describeSelection([path.join(root, 'gone.txt')]), null);
    assert.equal(await describeSelection([here, path.join(root, 'gone.txt')]), null);
  });

  it('follows a symlink that is the whole selection, as before', async () => {
    const target = file('real.txt', 42);
    const link = path.join(root, 'link.txt');
    fs.symlinkSync(target, link);
    assert.deepEqual(await describeSelection([link]), {
      kind: 'file',
      path: link,
      name: 'link.txt',
      size: 42,
    });
  });

  // The engine leaves symlinks out of a bundle's archive, so they must be
  // left out of what is shown and of what the receiver is told to expect.
  it('leaves a symlink out of a selection of several', async () => {
    const a = file('a.txt', 10);
    const b = file('b.txt', 20);
    const link = path.join(root, 'link.txt');
    fs.symlinkSync(a, link);
    assert.deepEqual(await describeSelection([a, link, b]), {
      kind: 'bundle',
      paths: [a, b],
      counts: { files: 2, folders: 0 },
      fileCount: 2,
      totalBytes: 30,
    });
  });

  it('sends what is left as itself when a selection comes down to one item', async () => {
    const a = file('a.txt', 10);
    const link = path.join(root, 'link.txt');
    fs.symlinkSync(a, link);
    assert.deepEqual(await describeSelection([a, link]), {
      kind: 'file',
      path: a,
      name: 'a.txt',
      size: 10,
    });
    const dir = folder('album', [5]);
    assert.equal((await describeSelection([link, dir]))?.kind, 'folder');
  });

  it('returns null when a selection of several holds nothing sendable', async () => {
    const a = file('a.txt');
    const l1 = path.join(root, 'l1');
    const l2 = path.join(root, 'l2');
    fs.symlinkSync(a, l1);
    fs.symlinkSync(a, l2);
    assert.equal(await describeSelection([l1, l2]), null);
  });

  it('does not count symlinks inside a picked folder', async () => {
    const dir = folder('album', [10, 20]);
    fs.symlinkSync(file('outside.txt', 999), path.join(dir, 'link'));
    const picked = await describeSelection([dir, file('b.txt', 1)]);
    assert.deepEqual(picked?.kind === 'bundle' ? [picked.fileCount, picked.totalBytes] : null, [
      3, 31,
    ]);
  });
});

describe('walkStats', () => {
  it('counts files at every depth and no directories', async () => {
    const dir = folder('tree');
    file('tree/a', 1);
    file('tree/x/b', 2);
    file('tree/x/y/c', 3);
    fs.mkdirSync(path.join(dir, 'empty'));
    assert.deepEqual(await walkStats(dir), { fileCount: 3, totalBytes: 6 });
  });
});
