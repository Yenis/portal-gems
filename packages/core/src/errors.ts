import type { TFunction } from 'i18next';

const rawMessage = (error: unknown): string =>
  String((error as { message?: unknown } | null | undefined)?.message ?? error ?? '');

// The rendezvous (mailbox) server is where both sides first meet. If it is
// unreachable, nothing works - the fix is usually "switch servers", not "check
// your wifi", so we both message it that way and offer a shortcut to Settings.
const SERVER_UNREACHABLE_RE =
  /rendezvous|connection refused|could not connect to the rendezvous/i;

// The engine gives the server CONNECT_TIMEOUT (20 s) to answer and then fails
// with exactly this text (pinned by `connect_timeout_message_is_pinned` in
// native/wormhole-core). It cannot tell a device that is offline from a server
// that is not answering, so the message names both.
const CONNECT_TIMEOUT_RE = /no answer from the connection server in time/i;

// A code holds two devices; the server turns a third away. The engine reports
// that with exactly this text (pinned by `crowded_message_is_pinned` in
// native/wormhole-core). The server answered, so this is about the code and
// offers no "Change server" shortcut. The string says only that the code is
// spent: the usual third arrival is the user's own earlier attempt, and
// "two devices are on your code" reads as a file gone to someone else.
const CROWDED_RE = /this code already has two devices on it/i;

/// True when the failure looks like the chosen server being unreachable - used
/// to offer a "Change server" shortcut, not just a message.
export function isServerUnreachableError(error: unknown): boolean {
  const raw = rawMessage(error);
  return SERVER_UNREACHABLE_RE.test(raw) || CONNECT_TIMEOUT_RE.test(raw);
}

// Transit is the data channel the two devices open to each other after they
// have met on the mailbox. magic-wormhole reports it as a bare "Transit
// error".
const TRANSIT_RE = /transit/i;

/**
 * True when the data channel never came up.
 *
 * Worth telling apart from the other failures: it means the two sides met and
 * then failed to reach each other directly or through the relay, so nothing
 * was delivered and retrying on a fresh code is worth doing. A transfer that
 * died some other way - the peer going away, a cancellation - may well have
 * arrived, and retrying it would be guesswork.
 */
export function isTransitFailure(error: unknown): boolean {
  return TRANSIT_RE.test(rawMessage(error));
}

// The engine's error strings are precise but raw (e.g.
// "Exception.Wormhole: Nameplate is unclaimed: 71300"). Map the recognizable
// cases to friendly, localized text; fall back to showing the raw message.
export function friendlyError(t: TFunction, error: unknown): string {
  const raw = rawMessage(error);
  if (/nameplate is unclaimed/i.test(raw)) return t('errors.wrongCode');
  if (CROWDED_RE.test(raw)) return t('errors.codeUnusable');
  if (/invalid server url/i.test(raw)) return t('errors.invalidServerUrl');
  if (/transfer was rejected|rejected the transfer|TransferRejected/i.test(raw))
    return t('errors.declinedBySender');
  if (CONNECT_TIMEOUT_RE.test(raw)) return t('errors.connectTimeout');
  if (isServerUnreachableError(raw)) return t('errors.serverUnreachable');
  // Transit failing says nothing about the code or the server, so it gets its
  // own message rather than one about either.
  if (isTransitFailure(raw)) return t('errors.transit');
  if (/peer|reset by peer|connection was lost|closed the connection/i.test(raw))
    return t('errors.peerGone');
  if (/websocket|dns|network|timed? ?out|unreachable|io error/i.test(raw))
    return t('errors.network');
  return t('errors.transferFailed', { message: raw });
}
