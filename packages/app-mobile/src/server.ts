// Mobile server-selection glue. Model/resolver live in @portalgems/core; here
// we persist the choice in native settings (EncryptedSharedPreferences via the
// PortalGemsNative module) and resolve it to the ServerConfig each transfer
// hands to the engine.

import {
  parseServerSettings,
  resolveServer,
  serializeServerSettings,
  type ServerConfig,
  type ServerSettings,
} from '@portalgems/core';
import { getSetting, setSetting } from './native';

const KEY = 'pg-server';

export async function loadServerSettings(): Promise<ServerSettings> {
  return parseServerSettings(await getSetting(KEY));
}

export async function saveServerSettings(s: ServerSettings): Promise<void> {
  await setSetting(KEY, serializeServerSettings(s));
}

/** The config every send/receive/pair call should pass to the engine. */
export async function currentServer(): Promise<ServerConfig> {
  return resolveServer(await loadServerSettings());
}
