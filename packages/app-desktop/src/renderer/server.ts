// Desktop server-selection glue. The protocol/model lives in @portalgems/core;
// here we just persist the user's choice in localStorage and resolve it to the
// concrete ServerConfig each transfer hands to the engine over IPC.

import {
  parseServerSettings,
  resolveServer,
  serializeServerSettings,
  type ServerConfig,
  type ServerSettings,
} from '@portalgems/core';

const KEY = 'pg-server';

export function loadServerSettings(): ServerSettings {
  return parseServerSettings(localStorage.getItem(KEY));
}

export function saveServerSettings(s: ServerSettings): void {
  localStorage.setItem(KEY, serializeServerSettings(s));
}

/** The config every send/receive/pair call should pass to the engine. */
export function currentServer(): ServerConfig {
  return resolveServer(loadServerSettings());
}
