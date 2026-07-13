import type { TFunction } from 'i18next';

const rawMessage = (error: unknown): string =>
  String((error as { message?: unknown } | null | undefined)?.message ?? error ?? '');

// The rendezvous (mailbox) server is where both sides first meet. If it is
// unreachable, nothing works - the fix is usually "switch servers", not "check
// your wifi", so we both message it that way and offer a shortcut to Settings.
const SERVER_UNREACHABLE_RE =
  /rendezvous|connection refused|could not connect to the rendezvous/i;

/// True when the failure looks like the chosen server being unreachable - used
/// to offer a "Change server" shortcut, not just a message.
export function isServerUnreachableError(error: unknown): boolean {
  return SERVER_UNREACHABLE_RE.test(rawMessage(error));
}

// The engine's error strings are precise but raw (e.g.
// "Exception.Wormhole: Nameplate is unclaimed: 71300"). Map the recognizable
// cases to friendly, localized text; fall back to showing the raw message.
export function friendlyError(t: TFunction, error: unknown): string {
  const raw = rawMessage(error);
  if (/nameplate is unclaimed/i.test(raw)) return t('errors.wrongCode');
  if (/invalid server url/i.test(raw)) return t('errors.invalidServerUrl');
  if (/transfer was rejected|rejected the transfer|TransferRejected/i.test(raw))
    return t('errors.declinedBySender');
  if (isServerUnreachableError(raw)) return t('errors.serverUnreachable');
  if (/peer|reset by peer|connection was lost|closed the connection/i.test(raw))
    return t('errors.peerGone');
  if (/websocket|dns|network|timed? ?out|unreachable|io error/i.test(raw))
    return t('errors.network');
  return t('errors.transferFailed', { message: raw });
}
