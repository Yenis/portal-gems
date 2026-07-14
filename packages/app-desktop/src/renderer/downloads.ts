// Default download location (renderer side). Absent/blank means the OS
// Downloads folder; the main process resolves that per call, so a stale
// path never needs migrating.

const KEY = 'pg-download-dir';

export function loadDownloadDir(): string | null {
  const v = localStorage.getItem(KEY);
  return v && v.trim() !== '' ? v : null;
}

export function saveDownloadDir(dir: string | null): void {
  if (dir) localStorage.setItem(KEY, dir);
  else localStorage.removeItem(KEY);
}
