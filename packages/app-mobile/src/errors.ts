import type { TFunction } from 'i18next';

// The engine's error strings are precise but raw (e.g.
// "Exception.Wormhole: Nameplate is unclaimed: 71300"). Map the recognizable
// cases to friendly, localized text; fall back to showing the raw message.
export function friendlyError(t: TFunction, error: unknown): string {
  const raw = String((error as any)?.message ?? error ?? '');
  if (/nameplate is unclaimed/i.test(raw)) return t('errors.wrongCode');
  if (/transfer was rejected|rejected the transfer|TransferRejected/i.test(raw))
    return t('errors.declinedBySender');
  if (/peer|reset by peer|connection was lost|closed the connection/i.test(raw))
    return t('errors.peerGone');
  if (/websocket|connection refused|dns|network|timed? ?out|unreachable|io error/i.test(raw))
    return t('errors.network');
  return t('errors.transferFailed', { message: raw });
}
