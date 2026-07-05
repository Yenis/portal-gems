import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './en.json';

// Phase 1 ships English; de/bs/ru/fr/es land in the polish phase. All UI
// strings must live here from day one — no literals in components.
export function initI18n(locale?: string): typeof i18next {
  if (!i18next.isInitialized) {
    i18next.use(initReactI18next).init({
      resources: { en: { translation: en } },
      lng: locale ?? 'en',
      fallbackLng: 'en',
      interpolation: { escapeValue: false },
    });
  }
  return i18next;
}
