// Remembers the folder the send picker was last used in, so it reopens there
// next time (mobile's document picker does this natively). Persisted in
// localStorage, so it survives restarts. Shared by the file and folder pickers.

const KEY = 'pg-last-send-dir';

export function loadLastSendDir(): string | null {
  const v = localStorage.getItem(KEY);
  return v && v.trim() !== '' ? v : null;
}

/** Remember where a just-picked file/folder lives (its parent directory). */
export function rememberSendLocation(pickedPath: string): void {
  const dir = parentDir(pickedPath);
  if (dir) localStorage.setItem(KEY, dir);
}

// Directory portion of a native path, tolerant of both `/` and `\` separators
// (Electron returns the OS-native path).
function parentDir(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : '';
}
