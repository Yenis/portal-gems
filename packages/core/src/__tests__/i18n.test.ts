import { describe, expect, it } from 'vitest';
import { resources, SUPPORTED_LANGUAGES } from '../i18n';
import en from '../i18n/en.json';

function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) =>
    typeof value === 'object' && value !== null
      ? flattenKeys(value as Record<string, unknown>, `${prefix}${key}.`)
      : [`${prefix}${key}`]
  );
}

const enKeys = flattenKeys(en).sort();

describe('translation completeness', () => {
  it('covers all six languages', () => {
    expect(Object.keys(resources).sort()).toEqual(
      [...SUPPORTED_LANGUAGES].sort()
    );
  });

  for (const lng of SUPPORTED_LANGUAGES) {
    it(`${lng} has exactly the same keys as en`, () => {
      const keys = flattenKeys(
        (resources as Record<string, { translation: Record<string, unknown> }>)[
          lng
        ].translation
      ).sort();
      expect(keys).toEqual(enKeys);
    });

    it(`${lng} has no empty strings`, () => {
      const translation = (
        resources as Record<string, { translation: Record<string, unknown> }>
      )[lng].translation;
      const check = (obj: Record<string, unknown>) => {
        for (const value of Object.values(obj)) {
          if (typeof value === 'object' && value !== null) {
            check(value as Record<string, unknown>);
          } else {
            expect(String(value).trim()).not.toBe('');
          }
        }
      };
      check(translation);
    });
  }

  it('interpolation placeholders match en in every language', () => {
    const placeholders = (obj: Record<string, unknown>, out: Map<string, string>, prefix = '') => {
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'object' && value !== null) {
          placeholders(value as Record<string, unknown>, out, `${prefix}${key}.`);
        } else {
          const found = [...String(value).matchAll(/\{\{(\w+)\}\}/g)]
            .map((m) => m[1])
            .sort()
            .join(',');
          out.set(`${prefix}${key}`, found);
        }
      }
      return out;
    };
    const enPh = placeholders(en as Record<string, unknown>, new Map());
    for (const lng of SUPPORTED_LANGUAGES) {
      const ph = placeholders(
        (resources as Record<string, { translation: Record<string, unknown> }>)[
          lng
        ].translation,
        new Map()
      );
      for (const [key, expected] of enPh) {
        expect(`${lng}:${key}:${ph.get(key)}`).toBe(`${lng}:${key}:${expected}`);
      }
    }
  });
});
