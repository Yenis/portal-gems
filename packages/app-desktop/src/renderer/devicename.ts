// What this computer calls itself when pairing.
//
// The hostname is the default and is usually right; it is also sometimes
// "MacBook-Pro-3.local" or a machine name from a workplace, so it can be
// overridden. The override lives in localStorage next to the other desktop
// settings, and is only ever read when a pairing payload or handshake is
// built - renaming afterwards does not reach devices already paired, which
// is why they can rename this one on their side.

import { sanitizeDeviceName } from '@portalgems/core';

const KEY = 'pg-device-name';

/** The override, or '' when the hostname is being used. */
export function loadDeviceNameOverride(): string {
  try {
    return sanitizeDeviceName(localStorage.getItem(KEY) ?? '');
  } catch {
    return '';
  }
}

/** Store an override; anything blank clears it and restores the hostname. */
export function saveDeviceNameOverride(raw: string): string {
  const clean = sanitizeDeviceName(raw);
  try {
    if (clean.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, clean);
  } catch {
    /* a browser with storage disabled still gets a working app */
  }
  return clean;
}

/** The hostname this machine reports, cleaned up the same way. */
export async function defaultDeviceName(): Promise<string> {
  const host = await window.portalgems.deviceName();
  return sanitizeDeviceName(host) || 'PortalGems desktop';
}

/** The name to send when pairing: the override if set, else the hostname. */
export async function myDeviceName(): Promise<string> {
  return loadDeviceNameOverride() || (await defaultDeviceName());
}
