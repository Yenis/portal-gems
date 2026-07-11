import React from 'react';
import { createRoot } from 'react-dom/client';
import { initI18n } from '@portalgems/core';
import App from './App';

async function boot() {
  const locale = await window.portalgems.locale().catch(() => 'en');
  initI18n(locale.split('-')[0]);
  const root = createRoot(document.getElementById('root')!);
  root.render(<App />);
}

boot();
