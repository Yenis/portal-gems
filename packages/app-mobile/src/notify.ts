import { AppState } from 'react-native';
import { getSetting, notifyFinished, setSetting } from './native';

// Whether to raise a notification when a transfer finishes or fails. On
// unless switched off in Settings - the same setting, under the same key, as
// the desktop app.
const KEY = 'pg-notifications';

export async function loadNotificationsEnabled(): Promise<boolean> {
  return (await getSetting(KEY).catch(() => null)) !== '0';
}

export function saveNotificationsEnabled(enabled: boolean): Promise<void> {
  return setSetting(KEY, enabled ? '' : '0');
}

/**
 * Tell the user a transfer ended - only while the app is not on screen, which
 * is the case this is for: a transfer started and left running. The screen
 * itself says it otherwise. Tapping the notification opens the app and does
 * nothing else; no action in it opens a received file. Never the reason a
 * transfer fails.
 */
export function notify(title: string, body: string): void {
  if (AppState.currentState === 'active') return;
  loadNotificationsEnabled()
    .then((enabled) => (enabled ? notifyFinished(title, body) : undefined))
    .catch(() => undefined);
}
