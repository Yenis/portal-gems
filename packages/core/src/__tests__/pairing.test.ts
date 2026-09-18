import { describe, expect, it } from 'vitest';
import {
  candidateBuckets,
  candidateCodes,
  classifyPairingInput,
  createPairingPayload,
  currentBucket,
  deriveCode,
  nextSendAttempt,
  parseSendAttempts,
  withSendFinished,
  withSendStarted,
  PAIRED_CODE_ATTEMPTS,
  encodePairingPayload,
  fromBase64Url,
  parsePairingPayload,
  toBase64Url,
  utf8Decode,
  utf8Encode,
  PAIRING_BUCKET_SECONDS,
  deviceLabel,
  sanitizeDeviceName,
  DEVICE_NAME_MAX_BYTES,
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

  // These literals are the derivation's actual output, cross-checked against
  // an independent Python implementation (hmac/hashlib) and against the C one
  // in native/wormhole-mini (tests/test_pair.c pins the same values). This
  // test used to compare deriveCode with itself, which could never fail.
  it('matches the frozen v1 vector', () => {
    expect(secret).toBe('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8');
    expect(deriveCode(secret, 5_900_000)).toBe('78847104-4b2c920e11-127666f43e');
    expect(deriveCode(secret, 0)).toBe('84198084-a64125dc4c-c6ce0273f7');
    expect(deriveCode(secret, 1)).toBe('86751495-84d8487eb6-1858ba58a6');
    expect(deriveCode(secret, 42)).toBe('93636662-ffcccbd531-9d38f615c1');
    expect(deriveCode(secret, 5_866_666)).toBe('10150805-bcac0279fb-c1ae797f75');
  });

  it('pins the payload encoding, non-ASCII name included', () => {
    expect(
      encodePairingPayload({ t: 'portalgems-pair', v: 1, name: 'Nokia E72 čćž', secret })
    ).toBe(
      'PGPAIR1:eyJ2IjoxLCJuYW1lIjoiTm9raWEgRTcyIMSNxIfFviIsInNlY3JldCI6IkFBRUNBd1FGQmdjSUNRb0xEQTBPRHhBUkVoTVVGUllYR0JrYUd4d2RIaDgifQ'
    );
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

  // Attempt 0 has to stay byte-identical to what every earlier release
  // derived, or an updated device stops meeting one that knows no attempts.
  it('leaves attempt 0 exactly where it was', () => {
    expect(deriveCode(secret, 5_900_000, 0)).toBe(deriveCode(secret, 5_900_000));
    expect(deriveCode(secret, 0, 0)).toBe('84198084-a64125dc4c-c6ce0273f7');
  });

  // Frozen the same way as the bucket vectors above, and for the same reason:
  // `native/wormhole-mini` has to derive these too before a Symbian peer can
  // meet a sender that moved past its first code.
  it('matches the frozen vector for the later attempts', () => {
    expect(deriveCode(secret, 5_900_000, 1)).toBe('40195543-473b0563ba-339609eb11');
    expect(deriveCode(secret, 5_900_000, 2)).toBe('48285071-b26659425e-40472610d4');
  });

  it('gives each later attempt its own code', () => {
    const codes = [0, 1, 2].map((a) => deriveCode(secret, 42, a));
    expect(new Set(codes).size).toBe(3);
    // and a later attempt is not just the next bucket under another name
    expect(codes[1]).not.toBe(deriveCode(secret, 43));
  });

  it('keeps the wormhole code shape on later attempts', () => {
    const [nameplate] = deriveCode(secret, 42, 2).split('-');
    expect(Number(nameplate)).toBeGreaterThanOrEqual(10_000_000);
    expect(Number(nameplate)).toBeLessThan(100_000_000);
  });
});

describe('receiver candidate codes', () => {
  const secret = toBase64Url(Uint8Array.from({ length: 32 }, (_, i) => i));
  const now = 5_900_000 * 300 * 1000;

  it('covers every bucket and attempt, without repeats', () => {
    const codes = candidateCodes(secret, now);
    expect(codes).toHaveLength(candidateBuckets(now).length * PAIRED_CODE_ATTEMPTS);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('looks first where a working sender actually is', () => {
    expect(candidateCodes(secret, now)[0]).toBe(deriveCode(secret, currentBucket(now), 0));
  });

  it('includes the code a sender moves to after a failure', () => {
    const bumped = deriveCode(secret, currentBucket(now), 1);
    expect(candidateCodes(secret, now)).toContain(bumped);
  });
});

describe('in-flight send markers', () => {
  const now = 5_900_000 * 300 * 1000;
  const bucket = currentBucket(now);

  it('starts at attempt 0 with nothing recorded', () => {
    expect(nextSendAttempt({}, 'dev-1', now)).toBe(0);
  });

  it('steps past a send that was never seen through', () => {
    const after = withSendStarted({}, 'dev-1', 0, now);
    expect(nextSendAttempt(after, 'dev-1', now)).toBe(1);
    expect(nextSendAttempt(withSendStarted(after, 'dev-1', 1, now), 'dev-1', now)).toBe(2);
  });

  it('returns to attempt 0 once a send completes', () => {
    const started = withSendStarted({}, 'dev-1', 0, now);
    expect(nextSendAttempt(withSendFinished(started, 'dev-1'), 'dev-1', now)).toBe(0);
  });

  it('keeps one device out of another device\'s way', () => {
    const started = withSendStarted({}, 'dev-1', 0, now);
    expect(nextSendAttempt(started, 'dev-2', now)).toBe(0);
  });

  it('ignores a marker from an older bucket, and forgets it', () => {
    const old = withSendStarted({}, 'dev-1', 1, now);
    const later = now + 300 * 1000;
    expect(nextSendAttempt(old, 'dev-1', later)).toBe(0);
    expect(withSendStarted(old, 'dev-2', 0, later)['dev-1']).toBeUndefined();
  });

  it('stops at the last attempt rather than inventing codes', () => {
    const exhausted = { 'dev-1': { bucket, attempt: PAIRED_CODE_ATTEMPTS - 1 } };
    expect(nextSendAttempt(exhausted, 'dev-1', now)).toBe(PAIRED_CODE_ATTEMPTS - 1);
  });

  it('survives a round trip through storage', () => {
    const started = withSendStarted({}, 'dev-1', 1, now);
    expect(parseSendAttempts(JSON.stringify(started))).toEqual(started);
  });

  it('reads anything unusable as no markers at all', () => {
    expect(parseSendAttempts(null)).toEqual({});
    expect(parseSendAttempts('')).toEqual({});
    expect(parseSendAttempts('not json')).toEqual({});
    expect(parseSendAttempts('[1,2]')).toEqual({});
    expect(parseSendAttempts('{"dev-1":{"bucket":"x"}}')).toEqual({});
    expect(parseSendAttempts('{"dev-1":null}')).toEqual({});
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

describe('pairing input', () => {
  it('recognises a pasted payload', () => {
    const encoded = encodePairingPayload(createPairingPayload('Laptop'));
    const got = classifyPairingInput(`  ${encoded}\n`);
    expect(got?.kind).toBe('payload');
    if (got?.kind === 'payload') expect(got.payload.name).toBe('Laptop');
  });

  it('recognises a typed wormhole code, trimmed', () => {
    expect(classifyPairingInput(' 7-crossover-clockwork ')).toEqual({
      kind: 'code',
      code: '7-crossover-clockwork',
    });
  });

  it('accepts the long derived-code shape too', () => {
    expect(classifyPairingInput('12345678-0a1b2c3d4e-5f60718293')?.kind).toBe('code');
  });

  it('rejects anything else rather than guessing', () => {
    expect(classifyPairingInput('')).toBeNull();
    expect(classifyPairingInput('crossover-clockwork')).toBeNull();
    expect(classifyPairingInput('7')).toBeNull();
    expect(classifyPairingInput('PGPAIR1:not-base64-json')).toBeNull();
    expect(classifyPairingInput('7 crossover clockwork')).toBeNull();
  });

  /* The invitation sent over a code is the ordinary encoded payload, so a
   * receiver that parses a text message must get back exactly the secret the
   * displayer will later derive codes from. */
  it('an invitation survives the text round trip unchanged', () => {
    const payload = createPairingPayload('Nokia E72');
    const received = parsePairingPayload(encodePairingPayload(payload));
    expect(received).toEqual(payload);
    expect(deriveCode(received!.secret, 5_000_000)).toBe(
      deriveCode(payload.secret, 5_000_000)
    );
  });
});

describe('device names and local renames', () => {
  it('shows the name a device gave when there is no rename', () => {
    expect(deviceLabel({ name: 'xollow', label: undefined })).toBe('xollow');
    expect(deviceLabel({ name: 'xollow' })).toBe('xollow');
  });

  it('shows the rename when there is one', () => {
    expect(deviceLabel({ name: 'sdk_gphone64_x86_64', label: 'Work phone' })).toBe(
      'Work phone'
    );
  });

  it('treats a blank rename as no rename, so clearing it restores the name', () => {
    expect(deviceLabel({ name: 'xollow', label: '' })).toBe('xollow');
    expect(deviceLabel({ name: 'xollow', label: '   ' })).toBe('xollow');
  });

  it('strips blanks, line breaks and control characters', () => {
    expect(sanitizeDeviceName('  Nokia E72  ')).toBe('Nokia E72');
    expect(sanitizeDeviceName('Nokia\nE72')).toBe('Nokia E72');
    expect(sanitizeDeviceName('Nokia\tE72')).toBe('Nokia E72');
    expect(sanitizeDeviceName('   ')).toBe('');
  });

  it('caps the length in bytes, not characters', () => {
    const ascii = sanitizeDeviceName('a'.repeat(200));
    expect(ascii.length).toBe(DEVICE_NAME_MAX_BYTES);

    // Each of these costs two bytes, so half as many survive.
    const accented = sanitizeDeviceName('ž'.repeat(200));
    expect(accented.length).toBe(DEVICE_NAME_MAX_BYTES / 2);
  });

  it('never cuts a character in half', () => {
    // An emoji is two UTF-16 code units and four UTF-8 bytes; a naive cut
    // would leave a lone surrogate behind.
    const out = sanitizeDeviceName('x'.repeat(DEVICE_NAME_MAX_BYTES - 2) + '🙂');
    expect(out.endsWith('🙂')).toBe(false);
    expect(out).toBe('x'.repeat(DEVICE_NAME_MAX_BYTES - 2));
    expect([...out].every((ch) => ch === 'x')).toBe(true);

    const fits = sanitizeDeviceName('x'.repeat(DEVICE_NAME_MAX_BYTES - 4) + '🙂');
    expect(fits.endsWith('🙂')).toBe(true);
  });

  it('a sanitized name survives the payload round trip', () => {
    const name = sanitizeDeviceName('  Yenis\u2019 Nokia E72 čćž  ');
    const payload = createPairingPayload(name);
    const back = parsePairingPayload(encodePairingPayload(payload));
    expect(back?.name).toBe(name);
  });
});
