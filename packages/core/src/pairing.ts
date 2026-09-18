// PortalGems device pairing: no backend, no accounts.
//
// Pairing exchanges a long-term 256-bit secret once - by QR code, by
// copy/paste, or through a one-time wormhole code (see "Pairing over a
// code" below).
// For every later transfer both devices independently derive the same one-time
// wormhole code from HMAC-SHA256(secret, time-bucket), so nobody types
// anything - the code carries the full entropy of the secret, which is far
// stronger than a typed two-word code.
//
// Both sides must derive identical codes, so this module is the single source
// of truth and runs unchanged on mobile (Hermes) and desktop (Node/Chromium).

import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';

export interface PairedDevice {
  /** stable local id */
  id: string;
  /** the peer's human-readable device name, as the peer gave it */
  name: string;
  /**
   * A local rename, shown instead of `name` on this device only. Nothing
   * sends it anywhere: the peer keeps calling itself whatever it calls
   * itself, and `name` is left alone so a rename can be undone by clearing
   * this. Absent, empty or blank means "use the name they gave".
   */
  label?: string;
  /** shared 32-byte secret, base64url */
  secret: string;
  /** ms epoch when paired */
  addedAt: number;
}

export interface PairingPayload {
  t: 'portalgems-pair';
  v: 1;
  /** device name of the side that generated (displays) the payload */
  name: string;
  /** shared 32-byte secret, base64url */
  secret: string;
}

/** Codes are derived per time bucket; adjacent buckets tolerate clock skew. */
export const PAIRING_BUCKET_SECONDS = 300;

/** How long a paired sender waits for the peer before giving up. */
export const PAIRED_SEND_TIMEOUT_MS = 45_000;

/** How long a paired receiver keeps polling candidate codes. */
export const PAIRED_RECEIVE_TIMEOUT_MS = 60_000;

/**
 * How long a single attempt on one candidate code may take before it is
 * abandoned and the next candidate tried.
 *
 * A code nobody has claimed fails in well under a second, and one a live
 * sender is waiting on completes almost as fast. The slow case is a nameplate
 * still held by a sender that died while waiting - killed, crashed, out of
 * battery. The mailbox keeps that claim, a receiver joins it, and then waits
 * for a handshake that will never come. Without a bound on each attempt that
 * one stale code stalls the whole loop past PAIRED_RECEIVE_TIMEOUT_MS, which
 * is only checked between attempts.
 */
export const PAIRED_ATTEMPT_TIMEOUT_MS = 10_000;

/**
 * How many codes each bucket holds.
 *
 * A sender that stopped without finishing still holds its claim on the
 * nameplate it used: the server keeps the claim, and only the sender that
 * completes releases it. A retry inside the same bucket therefore cannot use
 * the same code - it would join its own dead claim, and the receiver that
 * turned up would be a third claim, which the server rejects outright
 * (`crowded`). These are the codes a sender can move on to, and the ones a
 * receiver looks for. Three is enough for a couple of retries inside one
 * five-minute bucket; past that the bucket has rolled over anyway.
 */
export const PAIRED_CODE_ATTEMPTS = 3;

/** Where both apps keep their in-flight send markers. */
export const SEND_ATTEMPTS_KEY = 'pg-paired-send-attempts';

/** File name used for the one-shot pairing handshake transfer. */
export const PAIRING_HANDSHAKE_FILE = 'pg-pair-handshake.json';

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// Hermes has no TextDecoder (and older versions no TextEncoder), so we carry
// our own minimal UTF-8 codec to behave identically on every platform.
export function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000)
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63),
        0x80 | (cp & 63)
      );
  }
  return Uint8Array.from(out);
}

export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    let cp: number;
    if (b < 0x80) {
      cp = b;
      i += 1;
    } else if (b < 0xe0) {
      cp = ((b & 31) << 6) | (bytes[i + 1] & 63);
      i += 2;
    } else if (b < 0xf0) {
      cp = ((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63);
      i += 3;
    } else {
      cp =
        ((b & 7) << 18) |
        ((bytes[i + 1] & 63) << 12) |
        ((bytes[i + 2] & 63) << 6) |
        (bytes[i + 3] & 63);
      i += 4;
    }
    out += String.fromCodePoint(cp);
  }
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const c = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    out += B64URL[a >> 2];
    out += B64URL[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) out += B64URL[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) out += B64URL[c & 63];
  }
  return out;
}

export function fromBase64Url(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64URL.indexOf(ch);
    if (v < 0) throw new Error('invalid base64url');
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

export function createPairingPayload(myDeviceName: string): PairingPayload {
  return {
    t: 'portalgems-pair',
    v: 1,
    name: myDeviceName,
    secret: toBase64Url(randomBytes(32)),
  };
}

/** Compact string form: shown in QR codes and usable via copy/paste. */
export function encodePairingPayload(p: PairingPayload): string {
  const json = JSON.stringify({ v: p.v, name: p.name, secret: p.secret });
  return `PGPAIR1:${toBase64Url(utf8Encode(json))}`;
}

export function parsePairingPayload(raw: string): PairingPayload | null {
  const match = raw.trim().match(/^PGPAIR1:([A-Za-z0-9\-_]+)$/);
  if (!match) return null;
  try {
    const json = JSON.parse(utf8Decode(fromBase64Url(match[1])));
    if (json?.v !== 1 || typeof json.name !== 'string' || typeof json.secret !== 'string') {
      return null;
    }
    if (fromBase64Url(json.secret).length !== 32) return null;
    return { t: 'portalgems-pair', v: 1, name: json.name, secret: json.secret };
  } catch {
    return null;
  }
}

export function currentBucket(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / PAIRING_BUCKET_SECONDS);
}

/** Buckets a receiver should try, most likely first. */
export function candidateBuckets(nowMs: number = Date.now()): number[] {
  const b = currentBucket(nowMs);
  return [b, b - 1, b + 1];
}

/**
 * Every code a paired receiver should look for, most likely first: the
 * current bucket before its neighbours, and inside each bucket the first
 * attempt before the ones a sender only reaches after a failure.
 *
 * An unclaimed code fails in well under a second, so the extra candidates
 * cost little; the expensive one is a nameplate a dead sender still holds,
 * and that is bounded per attempt by `PAIRED_ATTEMPT_TIMEOUT_MS`.
 *
 * The pairing handshake deliberately keeps to `candidateBuckets` and attempt
 * 0. Its secret is one-shot: a pairing that fails is retried by showing a new
 * payload, which derives entirely new codes, so there is no stale claim to
 * route around and no reason to make that side poll three times as much.
 */
export function candidateCodes(secretB64: string, nowMs: number = Date.now()): string[] {
  const codes: string[] = [];
  for (const bucket of candidateBuckets(nowMs)) {
    for (let attempt = 0; attempt < PAIRED_CODE_ATTEMPTS; attempt += 1) {
      codes.push(deriveCode(secretB64, bucket, attempt));
    }
  }
  return codes;
}

/**
 * A paired send that was started and never seen through, so the code it used
 * must be assumed to be holding a claim until the bucket rolls over.
 */
export interface SendAttempt {
  bucket: number;
  attempt: number;
}

/** In-flight send markers, by paired device id, as stored between launches. */
export type SendAttempts = Record<string, SendAttempt>;

/** Read the stored markers; anything unrecognizable reads as "none". */
export function parseSendAttempts(raw: string | null | undefined): SendAttempts {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: SendAttempts = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const v = value as { bucket?: unknown; attempt?: unknown } | null;
      if (
        v &&
        typeof v.bucket === 'number' &&
        Number.isFinite(v.bucket) &&
        typeof v.attempt === 'number' &&
        Number.isFinite(v.attempt)
      ) {
        out[id] = { bucket: v.bucket, attempt: v.attempt };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Which attempt the next send to `deviceId` should use: the one after
 * whatever was left in flight in this bucket, and 0 when nothing was - a
 * marker from an older bucket says nothing about this one, whose codes
 * nobody has touched yet.
 *
 * The last attempt is returned again once they are exhausted. There is
 * nothing better to offer: every code this bucket holds is then claimed, and
 * the next bucket is at most five minutes away.
 */
export function nextSendAttempt(
  attempts: SendAttempts,
  deviceId: string,
  nowMs: number = Date.now()
): number {
  const marker = attempts[deviceId];
  if (!marker || marker.bucket !== currentBucket(nowMs)) return 0;
  return Math.min(marker.attempt + 1, PAIRED_CODE_ATTEMPTS - 1);
}

/**
 * Note that a send is starting on `attempt`. Markers from older buckets are
 * dropped here rather than swept elsewhere: their codes are unreachable now,
 * so they say nothing worth keeping.
 */
export function withSendStarted(
  attempts: SendAttempts,
  deviceId: string,
  attempt: number,
  nowMs: number = Date.now()
): SendAttempts {
  const bucket = currentBucket(nowMs);
  const out: SendAttempts = {};
  for (const [id, marker] of Object.entries(attempts)) {
    if (marker.bucket === bucket) out[id] = marker;
  }
  out[deviceId] = { bucket, attempt };
  return out;
}

/**
 * Note that a send finished. Only a completed send clears its marker: the
 * transfer released the nameplate on its way out, so the code is free again.
 * A cancelled, timed-out or crashed send leaves the marker standing, which is
 * exactly what makes the next one step past it.
 */
export function withSendFinished(attempts: SendAttempts, deviceId: string): SendAttempts {
  const out = { ...attempts };
  delete out[deviceId];
  return out;
}

/**
 * Derive the one-time wormhole code for a bucket. Format
 * `NNNNNNNN-xxxxxxxxxx-xxxxxxxxxx`: an 8-digit nameplate (collision chance on
 * the public mailbox server is negligible) and 80 bits of hex password.
 *
 * `attempt` picks between the codes a bucket holds (see
 * `PAIRED_CODE_ATTEMPTS`). Attempt 0 hashes exactly what every release has
 * hashed, so a device that knows nothing of attempts still meets an updated
 * one on the code both of them derive first.
 */
export function deriveCode(secretB64: string, bucket: number, attempt = 0): string {
  const key = fromBase64Url(secretB64);
  const mac = hmac(
    sha256,
    key,
    utf8Encode(
      attempt === 0
        ? `portalgems-code-v1:${bucket}`
        : `portalgems-code-v1:${bucket}:${attempt}`
    )
  );
  const u32 = ((mac[0] << 24) | (mac[1] << 16) | (mac[2] << 8) | mac[3]) >>> 0;
  const nameplate = String(10_000_000 + (u32 % 90_000_000));
  const hex = Array.from(mac.slice(4, 14))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${nameplate}-${hex.slice(0, 10)}-${hex.slice(10, 20)}`;
}

/**
 * The longest a device name may be once encoded, in bytes.
 *
 * A name crosses the wire in the pairing payload and is stored by every
 * platform, including one with fixed buffers: the Symbian client reads names
 * into 128 bytes and sends its own from 64. Staying under both means a name
 * can never be the reason a pairing fails, and the limit is in bytes rather
 * than characters because "Håkan's Nokia" costs more than it looks.
 */
export const DEVICE_NAME_MAX_BYTES = 60;

/**
 * Clean up a device name or label typed by a person: no surrounding blanks,
 * no control characters or line breaks (every platform stores these in line-
 * oriented files), and short enough for the smallest buffer that will hold
 * it. Truncation happens on a character boundary, never mid-character.
 *
 * Returns '' for anything that was only blanks, which callers treat as "no
 * name set" rather than storing an empty one.
 */
export function sanitizeDeviceName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const flattened = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (flattened.length === 0) return '';

  let out = '';
  let bytes = 0;
  // Array.from, not indexing: a character outside the basic plane is two
  // code units, and cutting between them would leave half of it behind.
  for (const ch of Array.from(flattened)) {
    const size = utf8Encode(ch).length;
    if (bytes + size > DEVICE_NAME_MAX_BYTES) break;
    out += ch;
    bytes += size;
  }
  return out.trim();
}

/**
 * What to call a paired device on screen: the local rename if there is one,
 * otherwise the name it gave at pairing. Every screen goes through this, so
 * a renamed device reads the same everywhere.
 */
export function deviceLabel(device: Pick<PairedDevice, 'name' | 'label'>): string {
  const label = device.label?.trim();
  return label && label.length > 0 ? label : device.name;
}

export function newDeviceId(): string {
  return toBase64Url(randomBytes(9));
}

/** Contents of the handshake file the scanner sends back to the displayer. */
export interface HandshakeMessage {
  v: 1;
  name: string;
}

export function encodeHandshake(myDeviceName: string): string {
  return JSON.stringify({ v: 1, name: myDeviceName } satisfies HandshakeMessage);
}

export function parseHandshake(raw: string): HandshakeMessage | null {
  try {
    const json = JSON.parse(raw);
    if (json?.v !== 1 || typeof json.name !== 'string') return null;
    return { v: 1, name: json.name };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pairing over a code
//
// A QR code needs one device to photograph the other, which rules out two
// desktops, a phone with a broken camera, and Symbian entirely. Instead the
// displaying side can allocate an ordinary wormhole code and send the encoded
// payload (`encodePairingPayload`) through it as a text message; the other side
// types the code, receives the payload, and continues exactly as if it had
// scanned it. Nothing about the payload, the code derivation or stored pairings
// changes, which is what keeps every existing pairing and the QR path working.
//
// The secret now crosses a PAKE-protected channel instead of a camera: an
// attacker gets one guess at the code, and a wrong guess fails visibly on both
// devices. A right guess would pair the attacker instead - and leave the real
// other device with a failed pairing, which is the signal to look at the
// paired-devices list.

/** A typed wormhole code: nameplate digits, then words. */
const WORMHOLE_CODE_RE = /^\d+(-[a-zA-Z0-9]+)+$/;

export type PairingInput =
  | { kind: 'code'; code: string }
  | { kind: 'payload'; payload: PairingPayload };

/**
 * What the user typed or pasted into the pairing field: a wormhole code to
 * receive an invitation over, or a pasted `PGPAIR1:` payload. One field takes
 * both so the screen does not have to explain the difference.
 */
export function classifyPairingInput(raw: string): PairingInput | null {
  const s = raw.trim();
  const payload = parsePairingPayload(s);
  if (payload) return { kind: 'payload', payload };
  if (WORMHOLE_CODE_RE.test(s)) return { kind: 'code', code: s };
  return null;
}
