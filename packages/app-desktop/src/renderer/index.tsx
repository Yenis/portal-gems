import React from 'react';
import { createRoot } from 'react-dom/client';
import { initI18n } from '@portalgems/core';
import App from './App';

async function boot() {
  const saved = localStorage.getItem('pg-language');
  const locale = saved ?? (await window.portalgems.locale().catch(() => 'en'));
  initI18n(locale);
  const root = createRoot(document.getElementById('root')!);
  root.render(<App />);
}

boot();
