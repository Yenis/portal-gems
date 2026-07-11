import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import bs from './bs.json';
import de from './de.json';
import en from './en.json';
import es from './es.json';
import fr from './fr.json';
import ru from './ru.json';

export const SUPPORTED_LANGUAGES = ['en', 'de', 'bs', 'ru', 'fr', 'es'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

export const resources = {
  en: { translation: en },
  de: { translation: de },
  bs: { translation: bs },
  ru: { translation: ru },
  fr: { translation: fr },
  es: { translation: es },
} as const;

export function isSupportedLanguage(lng: string): lng is Language {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(lng);
}

/** `locale` may be a full BCP-47 tag; only the language part is used. */
export function initI18n(locale?: string): typeof i18next {
  const lng = (locale ?? 'en').split(/[-_]/)[0];
  if (!i18next.isInitialized) {
    i18next.use(initReactI18next).init({
      resources,
      lng: isSupportedLanguage(lng) ? lng : 'en',
      fallbackLng: 'en',
      interpolation: { escapeValue: false },
    });
  }
  return i18next;
}

export function setLanguage(lng: string): void {
  const short = lng.split(/[-_]/)[0];
  i18next.changeLanguage(isSupportedLanguage(short) ? short : 'en');
}
