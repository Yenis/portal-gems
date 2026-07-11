import { useEffect, useState } from 'react';
import { themes, type Palette, type ThemeName } from '@portalgems/core';

export function loadThemeName(): ThemeName {
  const saved = localStorage.getItem('pg-theme');
  return saved && saved in themes ? (saved as ThemeName) : 'diamond';
}

export function saveThemeName(name: ThemeName): void {
  localStorage.setItem('pg-theme', name);
}

export function usePalette(themeName: ThemeName): Palette {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const [dark, setDark] = useState(mq.matches);
  useEffect(() => {
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return themes[themeName][dark ? 'dark' : 'light'];
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
