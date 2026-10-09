// Mobile pairing glue: storage via the (Keystore-encrypted) native store, and
// the two halves of the pairing handshake built on ordinary wormhole
// transfers. The protocol logic lives in @portalgems/core.

import {
  candidateCodes,
  currentBucket,
  deriveCode,
  encodeHandshake,
  isTransitFailure,
  newDeviceId,
  parseHandshake,
  PAIRING_HANDSHAKE_FILE,
  PAIRED_ATTEMPT_TIMEOUT_MS,
  PAIRED_CODE_ATTEMPTS,
  PAIRED_POLL_PAUSE_MS,
  PAIRED_RECEIVE_TIMEOUT_MS,
  parsePairingPayload,
  sanitizeDeviceName,
  sortByRecent,
  withDeviceUsed,
  type PairedDevice,
  type PairingPayload,
} from '@portalgems/core';
import { requestReceive, sendFile } from 'wormhole-rn';
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
    // Most recently used first, which is the order every list shows them in.
    return Array.isArray(parsed) ? sortByRecent(parsed) : [];
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

/** Note that a transfer with this device has just completed. */
export async function markDeviceUsed(id: string): Promise<void> {
  await saveDevices(withDeviceUsed(await loadDevices(), id));
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
    const server = await currentServer();
    let lastError: unknown = null;
    // A handshake that fails after the two sides have met cannot be retried
    // on the code it failed on: the nameplate was released when they met, so
    // it is gone. The usual reason is transit - the first connection between
    // two devices often needs a hole punched or the relay brought in, and it
    // can lose that race. Moving to the next code gives it another go without
    // asking the user for one, and the other side is already watching there.
    for (let attempt = 0; attempt < PAIRED_CODE_ATTEMPTS; attempt += 1) {
      if (signal.aborted) break;
      try {
        const code = deriveCode(payload.secret, currentBucket(), attempt);
        await sendFile(path, code, server, quietListener, { signal });
        return await addDevice(payload.name, payload.secret);
      } catch (e) {
        lastError = e;
        // Only transit is worth another code. Any other failure may have
        // happened after the handshake landed - the peer could be paired
        // already - and a retry would just talk to nobody.
        if (!isTransitFailure(e)) throw e;
      }
    }
    throw lastError ?? new Error('pairing cancelled');
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
  // Only a failure from after the peer was found is worth reporting. The
  // rest of the loop is unclaimed codes, which only ever mean "not yet".
  let realError: unknown = null;
  while (Date.now() < deadline && !signal.aborted) {
    for (const code of candidateCodes(payload.secret)) {
      if (signal.aborted) break;
      let incoming;
      try {
        // The bound belongs on the wait for the peer and nowhere else. A
        // nameplate still held by a sender that died would otherwise hold
        // the loop open - but the transfer that follows must be left alone,
        // because by then the two sides have met and the nameplate is
        // already released. Cutting that off strands both of them with
        // nothing left to find.
        incoming = await withAttemptBound(signal, (attempt) =>
          requestReceive(code, server, { signal: attempt })
        );
      } catch {
        continue;
      }
      try {
        const saved = await incoming.accept(incomingDir, quietListener, { signal });
        const message = parseHandshake(await readTextFile(saved));
        deleteFile(saved).catch(() => undefined);
        if (message) {
          return await addDevice(message.name, payload.secret);
        }
        realError = new Error('malformed handshake');
      } catch (e) {
        // The peer was here and the handshake failed - transit, usually. It
        // moves on to its next code, which this loop already covers.
        realError = e;
      }
    }
    if (signal.aborted) break;
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), PAIRED_POLL_PAUSE_MS);
    });
  }
  throw realError ?? new Error('pairing timed out');
}
