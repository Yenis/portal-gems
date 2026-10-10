import { describe, expect, it } from 'vitest';
import {
  bundleName,
  filesText,
  planSend,
  sanitizeBundleName,
  savedFilesText,
  type FilesCountKey,
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

const COUNTED: FilesCountKey[] = [
  'name',
  'summary',
  'sending',
  'sent',
  'receiving',
  'saved',
  'savedIn',
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

describe('filesText', () => {
  for (const lng of SUPPORTED_LANGUAGES) {
    const t = translator(lng);
    const strings = resources[lng].translation.files as Record<string, string>;

    it(`${lng}: every counted string has a form for exactly one file`, () => {
      for (const key of COUNTED) {
        expect(strings[key], key).toBeTypeOf('string');
        expect(strings[`${key}One`], `${key}One`).toBeTypeOf('string');
      }
    });

    it(`${lng}: the general form shows the count, the single form says 1`, () => {
      for (const key of COUNTED) {
        expect(strings[key], key).toContain('{{n}}');
        expect(strings[`${key}One`], `${key}One`).toContain('1');
        expect(strings[`${key}One`], `${key}One`).not.toContain('{{n}}');
      }
    });

    it(`${lng}: picks the single form for one file only`, () => {
      const extra = { size: '12 MB', folder: 'Inbox' };
      for (const key of COUNTED) {
        expect(filesText(t, key, 1, extra)).toBe(t(`files.${key}One`, extra));
        for (const n of [0, 2, 5, 21, 101]) {
          expect(filesText(t, key, n, extra)).toBe(t(`files.${key}`, { ...extra, n }));
          expect(filesText(t, key, n, extra)).toContain(String(n));
        }
      }
    });

    it(`${lng}: the prompt line carries the size, the saved line the folder`, () => {
      expect(filesText(t, 'summary', 5, { size: '12 MB' })).toContain('12 MB');
      expect(filesText(t, 'summary', 1, { size: '12 MB' })).toContain('12 MB');
      expect(filesText(t, 'savedIn', 5, { folder: 'Inbox' })).toContain('Inbox');
      expect(filesText(t, 'savedIn', 1, { folder: 'Inbox' })).toContain('Inbox');
    });
  }

  it('reads naturally in English', () => {
    const t = translator('en');
    expect(filesText(t, 'summary', 5, { size: '12 MB' })).toBe('5 files · 12 MB');
    expect(filesText(t, 'sending', 2)).toBe('Sending 2 files…');
    expect(filesText(t, 'sent', 1)).toBe('1 file sent.');
    expect(filesText(t, 'saved', 10)).toBe('10 files saved to Downloads.');
  });

  // Russian nouns take three forms by number (2 файла, 5 файлов, 21 файл).
  // The general string is worded so the noun never follows the number.
  it('never puts a Russian or Bosnian noun after a number above one', () => {
    for (const lng of ['ru', 'bs'] as const) {
      const strings = resources[lng].translation.files as Record<string, string>;
      for (const key of COUNTED) {
        expect(strings[key], `${lng} ${key}`).not.toMatch(/\{\{n\}\}\s+\p{L}/u);
      }
    }
  });

  it('goes through the real i18next the same way', async () => {
    const i18n = initI18n('en');
    const t = i18n.t.bind(i18n) as unknown as Parameters<typeof filesText>[0];
    expect(filesText(t, 'sending', 5)).toBe('Sending 5 files…');
    expect(filesText(t, 'sending', 1)).toBe('Sending 1 file…');
    await setLanguage('ru');
    expect(filesText(t, 'summary', 5, { size: '12 MB' })).toBe('Файлов: 5 · 12 MB');
    expect(filesText(t, 'summary', 1, { size: '12 MB' })).toBe('1 файл · 12 MB');
    await setLanguage('en');
  });
});

describe('bundleName', () => {
  // Month is zero-based: this is 10 October 2026, 14:32 local time.
  const when = new Date(2026, 9, 10, 14, 32, 59);

  it('says how many files and when', () => {
    expect(bundleName(translator('en'), 5, when)).toBe('5 files - 2026-10-10 14.32');
    expect(bundleName(translator('en'), 1, when)).toBe('1 file - 2026-10-10 14.32');
  });

  it('pads every part of the date', () => {
    const early = new Date(2027, 0, 3, 4, 5);
    expect(bundleName(translator('en'), 2, early)).toBe('2 files - 2027-01-03 04.05');
  });

  for (const lng of SUPPORTED_LANGUAGES) {
    it(`${lng}: is a legal folder name on every receiver`, () => {
      for (const n of [0, 1, 2, 5, 1000]) {
        const name = bundleName(translator(lng), n, when);
        // Nothing Windows reserves, no separators, no control characters.
        // eslint-disable-next-line no-control-regex
        expect(name).not.toMatch(/[<>:"/\\|?*\u0000-\u001f]/);
        expect(name).not.toMatch(/^[. ]|[. ]$/);
        expect(name).toContain('2026-10-10 14.32');
        expect(name).toContain(String(n));
        // Short enough for any filesystem, with room for " (1)".
        expect(new TextEncoder().encode(name).length).toBeLessThan(100);
      }
    });
  }

  it('follows the language it is given', () => {
    expect(bundleName(translator('de'), 5, when)).toBe('5 Dateien - 2026-10-10 14.32');
    expect(bundleName(translator('ru'), 5, when)).toBe('Файлы (5) - 2026-10-10 14.32');
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

describe('savedFilesText', () => {
  const t = translator('en');

  it('names Downloads when no folder was chosen', () => {
    expect(savedFilesText(t, { saved: 5, total: 5 })).toBe('5 files saved to Downloads.');
    expect(savedFilesText(t, { saved: 5, total: 5, folder: null })).toBe(
      '5 files saved to Downloads.'
    );
    expect(savedFilesText(t, { saved: 5, total: 5, folder: '' })).toBe(
      '5 files saved to Downloads.'
    );
  });

  it('names the chosen folder', () => {
    expect(savedFilesText(t, { saved: 5, total: 5, folder: 'Inbox' })).toBe(
      '5 files saved in Inbox.'
    );
    expect(savedFilesText(t, { saved: 1, total: 1, folder: 'Inbox' })).toBe(
      '1 file saved in Inbox.'
    );
  });

  it('says how many made it when not all did', () => {
    const partial = savedFilesText(t, { saved: 3, total: 5, folder: 'Inbox' });
    expect(partial).toContain('3 of 5');
    // It is neither of the success lines.
    expect(partial).not.toBe(savedFilesText(t, { saved: 5, total: 5, folder: 'Inbox' }));
    expect(savedFilesText(t, { saved: 0, total: 5 })).toContain('0 of 5');
  });

  for (const lng of SUPPORTED_LANGUAGES) {
    it(`${lng}: the partial line carries both numbers`, () => {
      const line = savedFilesText(translator(lng), { saved: 3, total: 7 });
      expect(line).toContain('3');
      expect(line).toContain('7');
    });
  }
});
