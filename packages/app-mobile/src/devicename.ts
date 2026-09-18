// What this phone calls itself when pairing.
//
// The name Android reports is the default and is often something like
// "sdk_gphone64_x86_64" or a model number, so it can be overridden. The
// override lives in the same encrypted settings store as everything else,
// and is only read when a pairing payload or handshake is built - renaming
// afterwards does not reach devices already paired, which is why they can
// rename this one on their side.

import { sanitizeDeviceName } from '@portalgems/core';
import { deviceName as nativeDeviceName, getSetting, setSetting } from './native';

const KEY = 'pg-device-name';

/** The name Android reports, cleaned up the same way a typed one is. */
export function defaultDeviceName(): string {
  return sanitizeDeviceName(nativeDeviceName) || 'PortalGems phone';
}

/** The override, or '' when the phone's own name is being used. */
export async function loadDeviceNameOverride(): Promise<string> {
  return sanitizeDeviceName((await getSetting(KEY)) ?? '');
}

/** Store an override; anything blank clears it and restores the default. */
export async function saveDeviceNameOverride(raw: string): Promise<string> {
  const clean = sanitizeDeviceName(raw);
  await setSetting(KEY, clean);
  return clean;
}

/** The name to send when pairing: the override if set, else the default. */
export async function myDeviceName(): Promise<string> {
  return (await loadDeviceNameOverride()) || defaultDeviceName();
}
