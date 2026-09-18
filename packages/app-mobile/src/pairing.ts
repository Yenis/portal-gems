// Mobile pairing glue: storage via the (Keystore-encrypted) native store, and
// the two halves of the pairing handshake built on ordinary wormhole
// transfers. The protocol logic lives in @portalgems/core.

import {
  candidateBuckets,
  currentBucket,
  deriveCode,
  encodeHandshake,
  newDeviceId,
  parseHandshake,
  PAIRING_HANDSHAKE_FILE,
  PAIRED_ATTEMPT_TIMEOUT_MS,
  PAIRED_RECEIVE_TIMEOUT_MS,
  parsePairingPayload,
  sanitizeDeviceName,
  type PairedDevice,
  type PairingPayload,
} from '@portalgems/core';
import { receiveFile, requestReceive, sendFile } from 'wormhole-rn';
import {
  cacheDir,
  deleteFile,
  getPairedDevicesJson,
  incomingDir,
  readTextFile,
  setPairedDevicesJson,
  writeTextFile,
} from './native';
import { currentServer } from './server';

export async function loadDevices(): Promise<PairedDevice[]> {
  try {
    const parsed = JSON.parse(await getPairedDevicesJson());
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveDevices(devices: PairedDevice[]): Promise<void> {
  await setPairedDevicesJson(JSON.stringify(devices));
}

export async function addDevice(name: string, secret: string): Promise<PairedDevice> {
  const devices = await loadDevices();
  const device: PairedDevice = {
    id: newDeviceId(),
    name,
    secret,
    addedAt: Date.now(),
  };
  devices.push(device);
  await saveDevices(devices);
  return device;
}

/**
 * Rename a paired device locally. An empty name clears the rename, so the
 * device goes back to calling itself what it calls itself; `name` is never
 * touched, which is what makes that possible.
 */
export async function renameDevice(id: string, label: string): Promise<void> {
  const clean = sanitizeDeviceName(label);
  const devices = await loadDevices();
  await saveDevices(
    devices.map((d) =>
      d.id === id ? { ...d, label: clean.length > 0 ? clean : undefined } : d
    )
  );
}

export async function removeDevice(id: string): Promise<void> {
  const devices = await loadDevices();
  await saveDevices(devices.filter((d) => d.id !== id));
}

/**
 * Run one attempt on a derived code, abandoned after PAIRED_ATTEMPT_TIMEOUT_MS
 * or when `outer` aborts, whichever comes first.
 *
 * A nameplate still held by a sender that died while waiting makes a receiver
 * join and then wait forever for a handshake that never comes, and a polling
 * loop's own deadline is only checked between attempts - so without this one
 * stale code stalls the whole loop. Aborting rejects the attempt, and the
 * caller moves on to the next candidate.
 */
export async function withAttemptBound<T>(
  outer: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const attempt = new AbortController();
  const forward = () => attempt.abort();
  if (outer.aborted) attempt.abort();
  outer.addEventListener('abort', forward);
  const timer = setTimeout(() => attempt.abort(), PAIRED_ATTEMPT_TIMEOUT_MS);
  try {
    return await run(attempt.signal);
  } finally {
    clearTimeout(timer);
    outer.removeEventListener('abort', forward);
  }
}

/** The code carried something other than a pairing invitation. */
export class NotAnInvitationError extends Error {}

/**
 * Joining side of pairing over a code: receive the invitation the other
 * device sent as a text message. A file offered on the code is declined, so
 * the sender fails cleanly instead of waiting.
 */
export async function receivePairingInvitation(
  code: string,
  signal: AbortSignal
): Promise<PairingPayload> {
  const server = await currentServer();
  const incoming = await requestReceive(code, server, { signal });
  const text = incoming.text();
  if (text === undefined) {
    incoming.reject().catch(() => undefined);
    throw new NotAnInvitationError();
  }
  const payload = parsePairingPayload(text);
  if (!payload) throw new NotAnInvitationError();
  return payload;
}

const quietListener = {
  onCode: () => {},
  onTransit: () => {},
  onProgress: () => {},
};

/**
 * Scanner side of the handshake: send our device name over the derived code.
 * On success the displayer has stored us; we store them (payload.name).
 */
export async function completePairingAsScanner(
  payload: PairingPayload,
  myName: string,
  signal: AbortSignal
): Promise<PairedDevice> {
  const path = await writeTextFile(
    cacheDir,
    PAIRING_HANDSHAKE_FILE,
    encodeHandshake(myName)
  );
  try {
    const code = deriveCode(payload.secret, currentBucket());
    const server = await currentServer();
    await sendFile(path, code, server, quietListener, { signal });
    return await addDevice(payload.name, payload.secret);
  } finally {
    deleteFile(path).catch(() => undefined);
  }
}

/**
 * Displayer side: poll the derived codes until the scanner's handshake file
 * arrives; returns the scanner's device name.
 */
export async function waitForPairingAsDisplayer(
  payload: PairingPayload,
  signal: AbortSignal
): Promise<PairedDevice> {
  const server = await currentServer();
  const deadline = Date.now() + PAIRED_RECEIVE_TIMEOUT_MS;
  let lastError: unknown = new Error('pairing timed out');
  while (Date.now() < deadline && !signal.aborted) {
    for (const bucket of candidateBuckets()) {
      if (signal.aborted) break;
      try {
        const code = deriveCode(payload.secret, bucket);
        const saved = await withAttemptBound(signal, (attempt) =>
          receiveFile(code, incomingDir, server, quietListener, { signal: attempt })
        );
        const message = parseHandshake(await readTextFile(saved));
        deleteFile(saved).catch(() => undefined);
        if (message) {
          return await addDevice(message.name, payload.secret);
        }
        lastError = new Error('malformed handshake');
      } catch (e) {
        lastError = e;
        // Unclaimed nameplate is the expected "not yet" case - keep polling.
      }
    }
  }
  throw lastError;
}
