import { describe, expect, it } from 'vitest';
import {
  bundleName,
  bundleText,
  countBundle,
  itemsText,
  planSend,
  sanitizeBundleName,
  savedBundleText,
  type BundleCounts,
  type BundleTextKey,
} from '../files';
import { initI18n, resources, setLanguage, SUPPORTED_LANGUAGES } from '../i18n';

const file = { isFolder: false };
const folder = { isFolder: true };

/** A translate function over one language's real strings, with no i18next in
 *  between: what these tests check is the strings and the key choice. */
function translator(lng: (typeof SUPPORTED_LANGUAGES)[number]) {
  const strings = resources[lng].translation as unknown as Record<
    string,
    Record<string, string>
  >;
  return (key: string, options: Record<string, unknown> = {}): string => {
    const [group, name] = key.split('.');
    const template = strings[group]?.[name];
    if (typeof template !== 'string') throw new Error(`no such string: ${key} (${lng})`);
    return template.replace(/\{\{(\w+)\}\}/g, (_, slot: string) => {
      if (!(slot in options)) throw new Error(`${key} (${lng}) needs {{${slot}}}`);
      return String(options[slot]);
    });
  };
}

const SENTENCES: BundleTextKey[] = ['summary', 'sending', 'sent', 'receiving', 'saved', 'savedIn'];

/** Every mix a bundle can be: files only, folders only, both, ones and manys. */
const MIXES: BundleCounts[] = [
  { files: 2, folders: 0 },
  { files: 7, folders: 0 },
  { files: 21, folders: 0 },
  { files: 0, folders: 2 },
  { files: 0, folders: 3 },
  { files: 7, folders: 2 },
  { files: 1, folders: 1 },
  { files: 1, folders: 4 },
  { files: 5, folders: 1 },
  { files: 101, folders: 12 },
];

describe('planSend', () => {
  it('sends nothing for an empty selection', () => {
    expect(planSend([])).toBe('nothing');
  });

  it('keeps one file on the plain file path', () => {
    expect(planSend([file])).toBe('file');
  });

  it('keeps one folder on the plain folder path', () => {
    expect(planSend([folder])).toBe('folder');
  });

  it('bundles two or more files', () => {
    expect(planSend([file, file])).toBe('bundle');
    expect(planSend(Array.from({ length: 200 }, () => file))).toBe('bundle');
  });

  it('bundles files and folders mixed, and several folders', () => {
    expect(planSend([file, folder])).toBe('bundle');
    expect(planSend([folder, file])).toBe('bundle');
    expect(planSend([folder, folder])).toBe('bundle');
  });
});

describe('countBundle', () => {
  it('counts files and folders apart', () => {
    expect(countBundle([file, file, file])).toEqual({ files: 3, folders: 0 });
    expect(countBundle([folder, folder])).toEqual({ files: 0, folders: 2 });
    expect(countBundle([file, folder, file, folder, file])).toEqual({ files: 3, folders: 2 });
    expect(countBundle([])).toEqual({ files: 0, folders: 0 });
  });
});

describe('itemsText', () => {
  it('reads naturally in English', () => {
    const t = translator('en');
    expect(itemsText(t, { files: 7, folders: 0 })).toBe('7 files');
    expect(itemsText(t, { files: 7, folders: 2 })).toBe('7 files and 2 folders');
    expect(itemsText(t, { files: 0, folders: 3 })).toBe('3 folders');
    expect(itemsText(t, { files: 1, folders: 1 })).toBe('1 file and 1 folder');
    expect(itemsText(t, { files: 1, folders: 4 })).toBe('1 file and 4 folders');
    expect(itemsText(t, { files: 5, folders: 1 })).toBe('5 files and 1 folder');
  });

  it('leaves out a kind there is none of, in every language', () => {
    for (const lng of SUPPORTED_LANGUAGES) {
      const t = translator(lng);
      const and = t('files.both', { files: '', folders: '' }).trim();
      expect(itemsText(t, { files: 7, folders: 0 }), lng).toBe(t('files.count', { n: 7 }));
      expect(itemsText(t, { files: 0, folders: 3 }), lng).toBe(t('files.folderCount', { n: 3 }));
      // The joiner only appears when there is something on both sides.
      expect(itemsText(t, { files: 7, folders: 0 }), lng).not.toContain(` ${and} `);
      expect(itemsText(t, { files: 7, folders: 0 }), lng).not.toContain('0');
    }
  });

  for (const lng of SUPPORTED_LANGUAGES) {
    const t = translator(lng);
    const strings = resources[lng].translation.files as Record<string, string>;

    it(`${lng}: each noun has a form for exactly one, and it is used for one only`, () => {
      for (const key of ['count', 'folderCount']) {
        expect(strings[key], key).toContain('{{n}}');
        expect(strings[`${key}One`], `${key}One`).toContain('1');
        expect(strings[`${key}One`], `${key}One`).not.toContain('{{n}}');
      }
      expect(itemsText(t, { files: 1, folders: 0 })).toBe(strings.countOne);
      expect(itemsText(t, { files: 0, folders: 1 })).toBe(strings.folderCountOne);
      for (const n of [0, 2, 5, 21, 101]) {
        expect(itemsText(t, { files: n, folders: 0 })).toBe(t('files.count', { n }));
      }
      for (const n of [2, 5, 21, 101]) {
        expect(itemsText(t, { files: 0, folders: n })).toBe(t('files.folderCount', { n }));
      }
    });

    it(`${lng}: a mix names both numbers, files first`, () => {
      for (const counts of MIXES.filter((m) => m.files > 0 && m.folders > 0)) {
        const text = itemsText(t, counts);
        const filesAt = text.indexOf(counted(t, 'count', counts.files));
        const foldersAt = text.indexOf(counted(t, 'folderCount', counts.folders));
        expect(filesAt, text).toBeGreaterThanOrEqual(0);
        expect(foldersAt, text).toBeGreaterThan(filesAt);
      }
    });
  }

  // Russian and Bosnian nouns take three forms by number (2 файла, 5 файлов,
  // 21 файл). The general string is worded so the noun never follows the
  // number, which makes one form right for all of them.
  it('never puts a Russian or Bosnian noun after a number above one', () => {
    for (const lng of ['ru', 'bs'] as const) {
      const strings = resources[lng].translation.files as Record<string, string>;
      for (const key of ['count', 'folderCount']) {
        expect(strings[key], `${lng} ${key}`).not.toMatch(/\{\{n\}\}\s+\p{L}/u);
      }
    }
  });
});

/** The counted noun on its own, the way `itemsText` picks it. */
function counted(
  t: ReturnType<typeof translator>,
  key: 'count' | 'folderCount',
  n: number
): string {
  return t(`files.${n === 1 ? `${key}One` : key}`, { n });
}

describe('bundleText', () => {
  for (const lng of SUPPORTED_LANGUAGES) {
    const t = translator(lng);
    const strings = resources[lng].translation.files as Record<string, string>;

    it(`${lng}: every sentence is built around the phrase, not around a number`, () => {
      for (const key of SENTENCES) {
        expect(strings[key], key).toContain('{{items}}');
        // A bare count in a sentence is where agreement goes wrong.
        expect(strings[key], key).not.toContain('{{n}}');
      }
    });

    it(`${lng}: every sentence carries the whole phrase for every mix`, () => {
      const extra = { size: '12 MB', folder: 'Inbox' };
      for (const key of SENTENCES) {
        for (const counts of MIXES) {
          const text = bundleText(t, key, counts, extra);
          expect(text.toLocaleLowerCase(), `${key} ${JSON.stringify(counts)}`).toContain(
            itemsText(t, counts).toLocaleLowerCase()
          );
        }
      }
    });

    it(`${lng}: starts with a capital or a digit`, () => {
      for (const key of SENTENCES) {
        for (const counts of MIXES) {
          const first = bundleText(t, key, counts, { size: '12 MB', folder: 'Inbox' }).charAt(0);
          expect(first, key).toBe(first.toLocaleUpperCase());
          expect(first, key).toMatch(/[\p{Lu}\p{N}¿]/u);
        }
      }
    });

    it(`${lng}: the prompt line carries the size, the saved line the folder`, () => {
      const mix = { files: 7, folders: 2 };
      expect(bundleText(t, 'summary', mix, { size: '12 MB' })).toContain('12 MB');
      expect(bundleText(t, 'savedIn', mix, { folder: 'Inbox' })).toContain('Inbox');
    });
  }

  it('reads naturally in English', () => {
    const t = translator('en');
    const mix = { files: 7, folders: 2 };
    expect(bundleText(t, 'summary', mix, { size: '40 MB' })).toBe(
      '7 files and 2 folders · 40 MB'
    );
    expect(bundleText(t, 'summary', { files: 7, folders: 0 }, { size: '12 MB' })).toBe(
      '7 files · 12 MB'
    );
    expect(bundleText(t, 'summary', { files: 0, folders: 3 }, { size: '28 MB' })).toBe(
      '3 folders · 28 MB'
    );
    expect(bundleText(t, 'sending', mix)).toBe('Sending 7 files and 2 folders…');
    expect(bundleText(t, 'sent', { files: 1, folders: 0 })).toBe('1 file sent.');
    expect(bundleText(t, 'saved', mix)).toBe('7 files and 2 folders saved to Downloads.');
    expect(bundleText(t, 'saved', { files: 0, folders: 3 })).toBe(
      '3 folders saved to Downloads.'
    );
  });

  it('capitalises a phrase that opens a Russian line', () => {
    const t = translator('ru');
    expect(bundleText(t, 'summary', { files: 7, folders: 2 }, { size: '40 MB' })).toBe(
      'Файлы (7) и папки (2) · 40 MB'
    );
    // Mid-sentence it stays as it is.
    expect(bundleText(t, 'sent', { files: 7, folders: 2 })).toBe(
      'Отправлено: файлы (7) и папки (2).'
    );
  });

  it('goes through the real i18next the same way', async () => {
    const i18n = initI18n('en');
    const t = i18n.t.bind(i18n) as unknown as Parameters<typeof bundleText>[0];
    expect(bundleText(t, 'sending', { files: 7, folders: 2 })).toBe(
      'Sending 7 files and 2 folders…'
    );
    expect(bundleText(t, 'sending', { files: 1, folders: 0 })).toBe('Sending 1 file…');
    await setLanguage('ru');
    expect(bundleText(t, 'summary', { files: 5, folders: 0 }, { size: '12 MB' })).toBe(
      'Файлы (5) · 12 MB'
    );
    await setLanguage('en');
  });
});

describe('bundleName', () => {
  // Month is zero-based: this is 10 October 2026, 14:32 local time.
  const when = new Date(2026, 9, 10, 14, 32, 59);

  it('says what it holds and when', () => {
    const t = translator('en');
    expect(bundleName(t, { files: 5, folders: 0 }, when)).toBe('5 files - 2026-10-10 14.32');
    expect(bundleName(t, { files: 7, folders: 2 }, when)).toBe(
      '7 files and 2 folders - 2026-10-10 14.32'
    );
    expect(bundleName(t, { files: 0, folders: 3 }, when)).toBe('3 folders - 2026-10-10 14.32');
    expect(bundleName(t, { files: 1, folders: 1 }, when)).toBe(
      '1 file and 1 folder - 2026-10-10 14.32'
    );
  });

  it('pads every part of the date', () => {
    const early = new Date(2027, 0, 3, 4, 5);
    expect(bundleName(translator('en'), { files: 2, folders: 0 }, early)).toBe(
      '2 files - 2027-01-03 04.05'
    );
  });

  for (const lng of SUPPORTED_LANGUAGES) {
    it(`${lng}: is a legal folder name on every receiver`, () => {
      for (const counts of [...MIXES, { files: 1000, folders: 1000 }]) {
        const name = bundleName(translator(lng), counts, when);
        // Nothing Windows reserves, no separators, no control characters.
        // eslint-disable-next-line no-control-regex
        expect(name).not.toMatch(/[<>:"/\\|?*\u0000-\u001f]/);
        expect(name).not.toMatch(/^[. ]|[. ]$/);
        expect(name).toContain('2026-10-10 14.32');
        // Short enough for any filesystem, with room for " (1)".
        expect(new TextEncoder().encode(name).length).toBeLessThan(100);
      }
    });
  }

  it('follows the language it is given', () => {
    expect(bundleName(translator('de'), { files: 5, folders: 2 }, when)).toBe(
      '5 Dateien und 2 Ordner - 2026-10-10 14.32'
    );
    expect(bundleName(translator('ru'), { files: 5, folders: 2 }, when)).toBe(
      'Файлы (5) и папки (2) - 2026-10-10 14.32'
    );
  });
});

describe('sanitizeBundleName', () => {
  it('leaves an ordinary name alone', () => {
    expect(sanitizeBundleName('5 files - 2026-10-10 14.32')).toBe('5 files - 2026-10-10 14.32');
  });

  it('removes what a file name cannot hold', () => {
    expect(sanitizeBundleName('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j');
    expect(sanitizeBundleName('tab\there\nnewline')).toBe('tab here newline');
  });

  it('cannot be used to climb out of the receive folder', () => {
    expect(sanitizeBundleName('../../etc')).toBe('etc');
    expect(sanitizeBundleName('..')).toBe('files');
  });

  it('trims the dots and spaces Windows would drop or hide', () => {
    expect(sanitizeBundleName('  .hidden.  ')).toBe('hidden');
  });

  it('never comes back empty', () => {
    expect(sanitizeBundleName('')).toBe('files');
    expect(sanitizeBundleName(' . . ')).toBe('files');
    expect(sanitizeBundleName('???')).toBe('files');
  });
});

describe('savedBundleText', () => {
  const t = translator('en');
  const five = { files: 5, folders: 0 };
  const mix = { files: 7, folders: 2 };

  it('names Downloads when no folder was chosen', () => {
    for (const folder of [undefined, null, '']) {
      expect(savedBundleText(t, { saved: five, expected: 5, folder })).toBe(
        '5 files saved to Downloads.'
      );
    }
  });

  it('names the chosen folder', () => {
    expect(savedBundleText(t, { saved: five, expected: 5, folder: 'Inbox' })).toBe(
      '5 files saved in Inbox.'
    );
    expect(savedBundleText(t, { saved: mix, expected: 9, folder: 'Inbox' })).toBe(
      '7 files and 2 folders saved in Inbox.'
    );
  });

  it('says how many made it when not all did', () => {
    const partial = savedBundleText(t, {
      saved: { files: 3, folders: 1 },
      expected: 9,
      folder: 'Inbox',
    });
    expect(partial).toContain('4 of 9');
    expect(savedBundleText(t, { saved: { files: 0, folders: 0 }, expected: 5 })).toContain(
      '0 of 5'
    );
  });

  // The counts in the offer are the sender's claim. What is reported as saved
  // is what was found on disk, so more than expected is simply success.
  it('does not call a surplus a failure', () => {
    expect(savedBundleText(t, { saved: mix, expected: 5 })).toBe(
      '7 files and 2 folders saved to Downloads.'
    );
  });

  for (const lng of SUPPORTED_LANGUAGES) {
    it(`${lng}: the partial line carries both numbers`, () => {
      const line = savedBundleText(translator(lng), {
        saved: { files: 2, folders: 1 },
        expected: 7,
      });
      expect(line).toContain('3');
      expect(line).toContain('7');
    });
  }
});
