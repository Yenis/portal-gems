// Server selection - which rendezvous (mailbox) and transit-relay servers a
// transfer uses. The engine (native/wormhole-core) keeps the magic-wormhole
// app id fixed, so any two clients pointed at the SAME rendezvous server
// interoperate - including the reference `wormhole` CLI on the public server.
//
// Why this exists: the public community server can (and does) go down, which
// takes every client with it. Letting users pick a reliable server - the
// PortalGems one, or their own self-hosted box - is the fix.

/// The concrete server addresses handed to the engine. Empty/missing fields
/// mean "use the built-in magic-wormhole public defaults".
export interface ServerConfig {
  rendezvousUrl?: string;
  transitUrl?: string;
}

/// The PortalGems-run server. TODO(deploy): set these to your VPS once the
/// mailbox + transit relay are running (see the self-hosting guide in the
/// README). Until then, the 'portalgems' choice cannot connect.
export const PORTALGEMS_RENDEZVOUS_URL = 'wss://relay.portalgems.example/v1';
export const PORTALGEMS_TRANSIT_URL = 'tcp://transit.portalgems.example:4001';

/// Which server the user picked. Persisted in each app's settings store.
export type ServerChoice = 'public' | 'portalgems' | 'custom';

export interface ServerSettings {
  choice: ServerChoice;
  /// Only meaningful when choice === 'custom'.
  customRendezvousUrl?: string;
  customTransitUrl?: string;
}

/// Default to the PortalGems server: a shipping app needs a dependable default,
/// and the public community server is too flaky to be one. Users who want
/// cross-client interop can switch to 'public' in Settings.
export const DEFAULT_SERVER_SETTINGS: ServerSettings = { choice: 'portalgems' };

/// The list of picker options, in display order. `custom` carries no fixed
/// config - its addresses come from `ServerSettings`.
export const SERVER_CHOICES: readonly ServerChoice[] = [
  'portalgems',
  'public',
  'custom',
] as const;

/// Turn the user's stored settings into the concrete config the engine needs.
export function resolveServer(s: ServerSettings): ServerConfig {
  switch (s.choice) {
    case 'public':
      return {};
    case 'portalgems':
      return {
        rendezvousUrl: PORTALGEMS_RENDEZVOUS_URL,
        transitUrl: PORTALGEMS_TRANSIT_URL,
      };
    case 'custom':
      return {
        rendezvousUrl: s.customRendezvousUrl?.trim() || undefined,
        transitUrl: s.customTransitUrl?.trim() || undefined,
      };
  }
}

/// Parse persisted JSON back into settings, tolerating anything malformed by
/// falling back to the default (never throw into the UI).
export function parseServerSettings(json: string | null | undefined): ServerSettings {
  if (!json) return { ...DEFAULT_SERVER_SETTINGS };
  try {
    const v = JSON.parse(json) as Partial<ServerSettings>;
    const choice: ServerChoice =
      v.choice === 'public' || v.choice === 'custom' || v.choice === 'portalgems'
        ? v.choice
        : DEFAULT_SERVER_SETTINGS.choice;
    return {
      choice,
      customRendezvousUrl:
        typeof v.customRendezvousUrl === 'string' ? v.customRendezvousUrl : undefined,
      customTransitUrl:
        typeof v.customTransitUrl === 'string' ? v.customTransitUrl : undefined,
    };
  } catch {
    return { ...DEFAULT_SERVER_SETTINGS };
  }
}

export function serializeServerSettings(s: ServerSettings): string {
  return JSON.stringify(s);
}

/// A rendezvous URL is a WebSocket URL (`ws://` or `wss://`). We only sanity
/// check the scheme + parseability - the engine reports connection failures.
export function isValidRendezvousUrl(url: string): boolean {
  const u = url.trim();
  if (!/^wss?:\/\//i.test(u)) return false;
  try {
    // eslint-disable-next-line no-new
    new URL(u);
    return true;
  } catch {
    return false;
  }
}

/// A transit-relay URL is a `tcp://host:port` URL.
export function isValidTransitUrl(url: string): boolean {
  const u = url.trim();
  if (!/^tcp:\/\//i.test(u)) return false;
  try {
    const parsed = new URL(u);
    return parsed.hostname.length > 0 && parsed.port.length > 0;
  } catch {
    return false;
  }
}

/// True when the custom choice has at least one usable, valid URL. (Either
/// field may be left blank to keep that server at its public default.)
export function isCustomServerUsable(s: ServerSettings): boolean {
  const r = s.customRendezvousUrl?.trim();
  const t = s.customTransitUrl?.trim();
  if (!r && !t) return false;
  if (r && !isValidRendezvousUrl(r)) return false;
  if (t && !isValidTransitUrl(t)) return false;
  return true;
}
