import type { TFunction } from 'i18next';

// The engine's error strings are precise but raw (e.g.
// "Exception.Wormhole: Nameplate is unclaimed: 71300"). Map the recognizable
// cases to friendly, localized text; fall back to showing the raw message.
export function friendlyError(t: TFunction, error: unknown): string {
  const raw = String((error as any)?.message ?? error ?? '');
  if (/nameplate is unclaimed/i.test(raw)) return t('errors.wrongCode');
  if (/invalid server url/i.test(raw)) return t('errors.invalidServerUrl');
  if (/transfer was rejected|rejected the transfer|TransferRejected/i.test(raw))
    return t('errors.declinedBySender');
  // The rendezvous (mailbox) server is where both sides first meet. If it is
  // unreachable, nothing works - point the user at the server picker, since
  // the fix is usually "switch servers", not "check your wifi".
  if (/rendezvous|connection refused|could not connect to the rendezvous/i.test(raw))
    return t('errors.serverUnreachable');
  if (/peer|reset by peer|connection was lost|closed the connection/i.test(raw))
    return t('errors.peerGone');
  if (/websocket|dns|network|timed? ?out|unreachable|io error/i.test(raw))
    return t('errors.network');
  return t('errors.transferFailed', { message: raw });
}
