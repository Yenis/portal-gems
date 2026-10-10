// What the user finds in their download folder after a transfer. Plain Node,
// no Electron: `npm test` bundles this file and runs it with `node --test`.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { dedupPath, landBundle, moveEntry } from '../landing';

let root: string;
let staged: string;
let downloads: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-landing-'));
  staged = path.join(root, 'staged');
  downloads = path.join(root, 'downloads');
  fs.mkdirSync(staged);
  fs.mkdirSync(downloads);
});

afterEach(() => {
  // A test may have made a directory read-only.
  fs.chmodSync(downloads, 0o755);
  fs.rmSync(root, { recursive: true, force: true });
});

const write = (dir: string, rel: string, content = rel) => {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const read = (rel: string) => fs.readFileSync(path.join(downloads, rel), 'utf8');
const listing = (dir = downloads) => fs.readdirSync(dir).sort();

/** Stage a bundle the way the engine leaves one: unpacked, in its own dir. */
function stage(files: string[], contentTag = ''): string {
  const dir = fs.mkdtempSync(path.join(staged, 'bundle-'));
  for (const rel of files) write(dir, rel, `${contentTag}${rel}`);
  return dir;
}

describe('landBundle', () => {
  it('puts each file directly in the download folder', async () => {
    const bundle = stage(['a.txt', 'b.jpg', 'c']);
    const landing = await landBundle(bundle, downloads);

    assert.deepEqual(landing, { files: 3, folders: 0, expected: 3 });
    assert.deepEqual(listing(), ['a.txt', 'b.jpg', 'c']);
    assert.equal(read('a.txt'), 'a.txt');
    // Nothing is left behind in staging.
    assert.deepEqual(listing(bundle), []);
  });

  // The whole point of the feature: five files, then five more, is ten files
  // in the folder - not two folders of five.
  it('lands two bundles side by side, with no folder for either', async () => {
    const first = ['1.jpg', '2.jpg', '3.jpg', '4.jpg', '5.jpg'];
    const second = ['6.jpg', '7.jpg', '8.jpg', '9.jpg', '10.jpg'];
    await landBundle(stage(first), downloads);
    await landBundle(stage(second), downloads);

    assert.deepEqual(listing(), [...first, ...second].sort());
    for (const name of listing()) {
      assert.ok(fs.statSync(path.join(downloads, name)).isFile(), name);
    }
  });

  it('leaves what was already there alone', async () => {
    write(downloads, 'mine.txt', 'mine');
    write(downloads, 'kept/inside.txt', 'kept');
    await landBundle(stage(['a.txt']), downloads);

    assert.deepEqual(listing(), ['a.txt', 'kept', 'mine.txt']);
    assert.equal(read('mine.txt'), 'mine');
    assert.equal(read('kept/inside.txt'), 'kept');
  });

  it('keeps both when a name is taken, and never overwrites', async () => {
    write(downloads, 'photo.jpg', 'the one that was there');
    const landing = await landBundle(stage(['photo.jpg', 'notes']), downloads);

    assert.deepEqual(landing, { files: 2, folders: 0, expected: 2 });
    assert.deepEqual(listing(), ['notes', 'photo (1).jpg', 'photo.jpg']);
    assert.equal(read('photo.jpg'), 'the one that was there');
    assert.equal(read('photo (1).jpg'), 'photo.jpg');
  });

  it('keeps counting up when the same names arrive again and again', async () => {
    for (const tag of ['first:', 'second:', 'third:']) {
      await landBundle(stage(['a.txt', 'noext'], tag), downloads);
    }
    assert.deepEqual(listing(), [
      'a (1).txt',
      'a (2).txt',
      'a.txt',
      'noext',
      'noext (1)',
      'noext (2)',
    ]);
    assert.equal(read('a.txt'), 'first:a.txt');
    assert.equal(read('a (1).txt'), 'second:a.txt');
    assert.equal(read('a (2).txt'), 'third:a.txt');
  });

  it('lands a folder as a folder, beside the loose files', async () => {
    const bundle = stage(['notes.txt', 'album/one.jpg', 'album/deep/two.jpg', 'other/x']);
    fs.mkdirSync(path.join(bundle, 'album', 'empty'));
    const landing = await landBundle(bundle, downloads);

    assert.deepEqual(landing, { files: 1, folders: 2, expected: 3 });
    assert.deepEqual(listing(), ['album', 'notes.txt', 'other']);
    assert.equal(read('album/deep/two.jpg'), 'album/deep/two.jpg');
    assert.ok(fs.statSync(path.join(downloads, 'album', 'empty')).isDirectory());
  });

  it('never merges into a folder that is already there', async () => {
    write(downloads, 'album/mine.jpg', 'mine');
    await landBundle(stage(['album/theirs.jpg']), downloads);

    assert.deepEqual(listing(), ['album', 'album (1)']);
    assert.deepEqual(listing(path.join(downloads, 'album')), ['mine.jpg']);
    assert.deepEqual(listing(path.join(downloads, 'album (1)')), ['theirs.jpg']);
  });

  it('does not split a folder name at its dot', async () => {
    write(downloads, 'my.stuff/a', 'a');
    write(downloads, 'report.pdf', 'pdf');
    await landBundle(stage(['my.stuff/b', 'report.pdf']), downloads);

    assert.deepEqual(listing(), ['my.stuff', 'my.stuff (1)', 'report (1).pdf', 'report.pdf']);
  });

  it('treats a file and a folder of one name as a clash too', async () => {
    write(downloads, 'report', 'a file');
    await landBundle(stage(['report/inside.txt']), downloads);

    assert.deepEqual(listing(), ['report', 'report (1)']);
    assert.ok(fs.statSync(path.join(downloads, 'report')).isFile());
    assert.ok(fs.statSync(path.join(downloads, 'report (1)')).isDirectory());
  });

  it('keeps names with spaces, dots and non-ASCII letters as they are', async () => {
    const names = ['Čćž šđ.txt', 'two  spaces.tar.gz', '.hidden', 'файл.jpg'];
    await landBundle(stage(names), downloads);
    assert.deepEqual(listing(), [...names].sort());
  });

  it('reports an empty bundle as nothing expected and nothing saved', async () => {
    const landing = await landBundle(stage([]), downloads);
    assert.deepEqual(landing, { files: 0, folders: 0, expected: 0 });
    assert.deepEqual(listing(), []);
  });

  // The last step is item by item. When it cannot write, the result has to
  // say so in numbers - the screen turns this into "0 of 3".
  it('says how many made it when the folder cannot be written', async (t) => {
    if (process.getuid?.() === 0) return t.skip('root ignores directory permissions');
    const bundle = stage(['a.txt', 'b.txt', 'album/c.txt']);
    fs.chmodSync(downloads, 0o555);

    const landing = await landBundle(bundle, downloads);
    assert.deepEqual(landing, { files: 0, folders: 0, expected: 3 });
    assert.deepEqual(listing(), []);
  });

  it('carries on past one item that cannot be moved', async (t) => {
    if (process.getuid?.() === 0) return t.skip('root ignores directory permissions');
    const bundle = stage(['a.txt', 'locked/inner.txt', 'z.txt']);
    // Moving a directory to another parent rewrites its ".." entry, which
    // needs write permission on the directory itself. Where the platform
    // enforces that, this one stays behind; the files around it must move
    // either way, and it must never be counted as saved if it did not.
    const locked = path.join(bundle, 'locked');
    fs.chmodSync(locked, 0o555);

    const landing = await landBundle(bundle, downloads);
    const stayed = fs.existsSync(locked);
    fs.chmodSync(stayed ? locked : path.join(downloads, 'locked'), 0o755);

    assert.equal(landing.expected, 3);
    assert.equal(landing.files, 2);
    assert.equal(landing.folders, stayed ? 0 : 1);
    assert.equal(read('a.txt'), 'a.txt');
    assert.equal(read('z.txt'), 'z.txt');
    assert.equal(listing().includes('locked'), !stayed);
  });
});

describe('dedupPath', () => {
  it('returns the name itself when it is free', () => {
    assert.equal(dedupPath(downloads, 'a.txt'), path.join(downloads, 'a.txt'));
  });

  it('numbers before the extension for a file, after the name for a folder', () => {
    write(downloads, 'a.txt');
    write(downloads, 'a (1).txt');
    fs.mkdirSync(path.join(downloads, 'my.stuff'));
    assert.equal(dedupPath(downloads, 'a.txt'), path.join(downloads, 'a (2).txt'));
    assert.equal(dedupPath(downloads, 'my.stuff', true), path.join(downloads, 'my.stuff (1)'));
  });

  it('does not take a leading dot for an extension', () => {
    write(downloads, '.hidden');
    assert.equal(dedupPath(downloads, '.hidden'), path.join(downloads, '.hidden (1)'));
  });
});

describe('moveEntry', () => {
  it('moves a file and a directory, leaving nothing at the source', async () => {
    write(staged, 'f.txt', 'file');
    write(staged, 'd/inner.txt', 'inner');
    await moveEntry(path.join(staged, 'f.txt'), path.join(downloads, 'f.txt'));
    await moveEntry(path.join(staged, 'd'), path.join(downloads, 'd'));

    assert.equal(read('f.txt'), 'file');
    assert.equal(read('d/inner.txt'), 'inner');
    assert.deepEqual(listing(staged), []);
  });
});
