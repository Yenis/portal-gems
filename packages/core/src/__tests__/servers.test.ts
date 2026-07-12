import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SERVER_SETTINGS,
  PORTALGEMS_RENDEZVOUS_URL,
  PORTALGEMS_TRANSIT_URL,
  availableServerChoices,
  isCustomServerUsable,
  isPortalgemsConfigured,
  isValidRendezvousUrl,
  isValidTransitUrl,
  parseServerSettings,
  resolveServer,
  serializeServerSettings,
} from '../servers';

describe('resolveServer', () => {
  it('public means library defaults (empty config)', () => {
    expect(resolveServer({ choice: 'public' })).toEqual({});
  });

  it('portalgems returns the dedicated server URLs', () => {
    expect(resolveServer({ choice: 'portalgems' })).toEqual({
      rendezvousUrl: PORTALGEMS_RENDEZVOUS_URL,
      transitUrl: PORTALGEMS_TRANSIT_URL,
    });
  });

  it('custom passes through trimmed URLs, blanks become undefined', () => {
    expect(
      resolveServer({
        choice: 'custom',
        customRendezvousUrl: '  wss://me.example/v1  ',
        customTransitUrl: '   ',
      })
    ).toEqual({ rendezvousUrl: 'wss://me.example/v1', transitUrl: undefined });
  });
});

describe('availability', () => {
  it('default is the public server', () => {
    expect(DEFAULT_SERVER_SETTINGS.choice).toBe('public');
  });

  it('hides portalgems until its URLs are real', () => {
    // Placeholder URLs still contain "example", so it must be hidden.
    expect(isPortalgemsConfigured()).toBe(false);
    expect(availableServerChoices()).toEqual(['public', 'custom']);
  });
});

describe('parseServerSettings', () => {
  it('falls back to default on null/garbage/unknown choice', () => {
    expect(parseServerSettings(null)).toEqual(DEFAULT_SERVER_SETTINGS);
    expect(parseServerSettings('not json{')).toEqual(DEFAULT_SERVER_SETTINGS);
    expect(parseServerSettings('{"choice":"bogus"}').choice).toBe(
      DEFAULT_SERVER_SETTINGS.choice
    );
  });

  it('round-trips through serialize', () => {
    const s = {
      choice: 'custom' as const,
      customRendezvousUrl: 'wss://me.example/v1',
      customTransitUrl: 'tcp://me.example:4001',
    };
    expect(parseServerSettings(serializeServerSettings(s))).toEqual(s);
  });
});

describe('URL validation', () => {
  it('accepts ws/wss rendezvous, rejects others', () => {
    expect(isValidRendezvousUrl('wss://host/v1')).toBe(true);
    expect(isValidRendezvousUrl('ws://host:4000/v1')).toBe(true);
    expect(isValidRendezvousUrl('tcp://host:4001')).toBe(false);
    expect(isValidRendezvousUrl('http://host')).toBe(false);
    expect(isValidRendezvousUrl('garbage')).toBe(false);
  });

  it('accepts tcp relay with host+port, rejects others', () => {
    expect(isValidTransitUrl('tcp://host:4001')).toBe(true);
    expect(isValidTransitUrl('tcp://host')).toBe(false);
    expect(isValidTransitUrl('wss://host/v1')).toBe(false);
  });
});

describe('isCustomServerUsable', () => {
  it('needs at least one valid URL', () => {
    expect(isCustomServerUsable({ choice: 'custom' })).toBe(false);
    expect(
      isCustomServerUsable({ choice: 'custom', customRendezvousUrl: 'wss://h/v1' })
    ).toBe(true);
    expect(
      isCustomServerUsable({ choice: 'custom', customRendezvousUrl: 'bad' })
    ).toBe(false);
    expect(
      isCustomServerUsable({
        choice: 'custom',
        customRendezvousUrl: 'wss://h/v1',
        customTransitUrl: 'nope',
      })
    ).toBe(false);
  });
});
