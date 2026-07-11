// PortalGems device pairing: no backend, no accounts.
//
// Pairing exchanges a long-term 256-bit secret once (QR code or copy/paste).
// For every later transfer both devices independently derive the same one-time
// wormhole code from HMAC-SHA256(secret, time-bucket), so nobody types
// anything — the code carries the full entropy of the secret, which is far
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
  /** the peer's human-readable device name */
  name: string;
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
 * Derive the one-time wormhole code for a bucket. Format
 * `NNNNNNNN-xxxxxxxxxx-xxxxxxxxxx`: an 8-digit nameplate (collision chance on
 * the public mailbox server is negligible) and 80 bits of hex password.
 */
export function deriveCode(secretB64: string, bucket: number): string {
  const key = fromBase64Url(secretB64);
  const mac = hmac(
    sha256,
    key,
    utf8Encode(`portalgems-code-v1:${bucket}`)
  );
  const u32 = ((mac[0] << 24) | (mac[1] << 16) | (mac[2] << 8) | mac[3]) >>> 0;
  const nameplate = String(10_000_000 + (u32 % 90_000_000));
  const hex = Array.from(mac.slice(4, 14))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${nameplate}-${hex.slice(0, 10)}-${hex.slice(10, 20)}`;
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
