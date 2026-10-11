// Whether to raise a system notification when a transfer finishes or fails.
// On unless switched off in Settings; main shows one only while the window
// is not focused, so this is the user's choice and that is the app's.

const KEY = 'pg-notifications';

export function loadNotificationsEnabled(): boolean {
  return localStorage.getItem(KEY) !== '0';
}

export function saveNotificationsEnabled(enabled: boolean): void {
  if (enabled) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, '0');
}

/** Tell the user a transfer ended. Never the reason a transfer fails. */
export function notify(title: string, body: string): void {
  if (!loadNotificationsEnabled()) return;
  window.portalgems.notify(title, body).catch(() => undefined);
}
