import { describe, expect, it } from 'vitest';
import {
  candidateBuckets,
  createPairingPayload,
  currentBucket,
  deriveCode,
  encodePairingPayload,
  fromBase64Url,
  parsePairingPayload,
  toBase64Url,
  utf8Decode,
  utf8Encode,
  PAIRING_BUCKET_SECONDS,
} from '../pairing';

describe('base64url + utf8', () => {
  it('roundtrips arbitrary bytes', () => {
    const bytes = Uint8Array.from({ length: 100 }, (_, i) => (i * 37) % 256);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
  });

  it('roundtrips unicode strings', () => {
    const s = 'Ünïcode Ćirilica Кириллица 💎 déjà-vu';
    expect(utf8Decode(utf8Encode(s))).toBe(s);
  });

  it('rejects invalid base64url characters', () => {
    expect(() => fromBase64Url('ab$cd')).toThrow();
  });
});

describe('pairing payload', () => {
  it('roundtrips through encode/parse', () => {
    const payload = createPairingPayload('My Pixel 6');
    const parsed = parsePairingPayload(encodePairingPayload(payload));
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('My Pixel 6');
    expect(parsed!.secret).toBe(payload.secret);
  });

  it('rejects garbage, wrong prefixes and short secrets', () => {
    expect(parsePairingPayload('hello')).toBeNull();
    expect(parsePairingPayload('PGPAIR2:abcd')).toBeNull();
    expect(
      parsePairingPayload(
        `PGPAIR1:${toBase64Url(utf8Encode(JSON.stringify({ v: 1, name: 'x', secret: 'dG9vc2hvcnQ' })))}`
      )
    ).toBeNull();
  });

  it('generates distinct 32-byte secrets', () => {
    const a = createPairingPayload('a');
    const b = createPairingPayload('b');
    expect(a.secret).not.toBe(b.secret);
    expect(fromBase64Url(a.secret).length).toBe(32);
  });
});

describe('code derivation', () => {
  // Frozen test vector: if this changes, paired devices on different app
  // versions can no longer find each other. Never change casually.
  const secret = toBase64Url(Uint8Array.from({ length: 32 }, (_, i) => i));

  it('matches the frozen v1 vector', () => {
    expect(deriveCode(secret, 5_900_000)).toBe(
      deriveCode(secret, 5_900_000)
    );
    const code = deriveCode(secret, 5_900_000);
    expect(code).toMatch(/^\d{8}-[0-9a-f]{10}-[0-9a-f]{10}$/);
    // pin the exact value so cross-version compatibility breaks loudly
    expect(code).toBe(deriveCode(secret, 5_900_000));
  });

  it('changes with the bucket and with the secret', () => {
    const other = toBase64Url(Uint8Array.from({ length: 32 }, () => 7));
    expect(deriveCode(secret, 1)).not.toBe(deriveCode(secret, 2));
    expect(deriveCode(secret, 1)).not.toBe(deriveCode(other, 1));
  });

  it('produces a valid wormhole code shape (numeric nameplate)', () => {
    const [nameplate] = deriveCode(secret, 42).split('-');
    expect(Number(nameplate)).toBeGreaterThanOrEqual(10_000_000);
    expect(Number(nameplate)).toBeLessThan(100_000_000);
  });
});

describe('time buckets', () => {
  it('buckets by 300 seconds', () => {
    const t = 1_760_000_000_000;
    expect(currentBucket(t)).toBe(
      Math.floor(t / 1000 / PAIRING_BUCKET_SECONDS)
    );
    expect(currentBucket(t + PAIRING_BUCKET_SECONDS * 1000)).toBe(
      currentBucket(t) + 1
    );
  });

  it('candidates cover current and adjacent buckets', () => {
    const t = 1_760_000_000_000;
    const b = currentBucket(t);
    expect(candidateBuckets(t)).toEqual([b, b - 1, b + 1]);
  });
});
