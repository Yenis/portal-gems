import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { friendlyError, isServerUnreachableError, isTransitFailure } from '../errors';

// Returns the key, so each case reads as "this engine message -> that string".
const t = ((key: string) => key) as unknown as TFunction;

// The engine's text for a server that did not answer in time, as pinned by
// `connect_timeout_message_is_pinned` in native/wormhole-core.
const CONNECT_TIMEOUT = 'no answer from the connection server in time';

describe('friendlyError', () => {
  it('gives a connect timeout its own message', () => {
    expect(friendlyError(t, new Error(CONNECT_TIMEOUT))).toBe('errors.connectTimeout');
    // Still recognized with a binding's prefix in front of it.
    expect(friendlyError(t, `Exception.ConnectTimeout: ${CONNECT_TIMEOUT}`)).toBe(
      'errors.connectTimeout',
    );
  });

  it('offers the server shortcut on a connect timeout', () => {
    expect(isServerUnreachableError(new Error(CONNECT_TIMEOUT))).toBe(true);
    expect(isTransitFailure(new Error(CONNECT_TIMEOUT))).toBe(false);
  });

  it('keeps the messages it already had', () => {
    expect(friendlyError(t, 'Nameplate is unclaimed: 71300')).toBe('errors.wrongCode');
    expect(friendlyError(t, 'invalid server URL: nope')).toBe('errors.invalidServerUrl');
    expect(friendlyError(t, 'Error with the rendezvous server connection')).toBe(
      'errors.serverUnreachable',
    );
    expect(friendlyError(t, 'Transit error')).toBe('errors.transit');
    expect(friendlyError(t, 'connection reset by peer')).toBe('errors.peerGone');
    expect(friendlyError(t, 'websocket closed')).toBe('errors.network');
    expect(friendlyError(t, 'something else')).toBe('errors.transferFailed');
  });
});
