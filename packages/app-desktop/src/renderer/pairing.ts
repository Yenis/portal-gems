// Desktop pairing glue (renderer side). Mirrors app-mobile/src/pairing.ts;
// the protocol logic lives in @portalgems/core, engine access goes over IPC.

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
  sanitizeDeviceName,
  wantsMessageHandshake,
  sortByRecent,
  withDeviceUsed,
  type PairedDevice,
  type PairingPayload,
} from '@portalgems/core';
import { currentServer } from './server';

const pg = () => window.portalgems;

export async function loadDevices(): Promise<PairedDevice[]> {
  try {
    const parsed = JSON.parse(await pg().pairsGet());
    // Most recently used first, which is the order every list shows them in.
    return Array.isArray(parsed) ? sortByRecent(parsed) : [];
  } catch {
    return [];
  }
}

export async function saveDevices(devices: PairedDevice[]): Promise<void> {
  await pg().pairsSet(JSON.stringify(devices));
}

export async function addDevice(name: string, secret: string): Promise<PairedDevice> {
  const devices = await loadDevices();
  const device: PairedDevice = { id: newDeviceId(), name, secret, addedAt: Date.now() };
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
 * One attempt at receiving on a derived code, abandoned after
 * PAIRED_ATTEMPT_TIMEOUT_MS. A nameplate still held by a sender that died
 * while waiting would otherwise hold the attempt - and the polling loop
 * around it - open indefinitely. Cancelling rejects the pending request, so
 * callers simply move on to the next candidate.
 */
export function requestReceiveBounded(
  transferId: number,
  code: string
): ReturnType<Window['portalgems']['requestReceive']> {
  const timer = setTimeout(() => pg().cancel(transferId), PAIRED_ATTEMPT_TIMEOUT_MS);
  return pg()
    .requestReceive(transferId, code, currentServer())
    .finally(() => clearTimeout(timer));
}

/**
 * Scanner/paster side: send our device name over the derived code.
 *
 * The name travels as a wormhole *message* where the other side can read one
 * (`payload.hs`). A file needs transit - a connection the two devices open to
 * each other - and the first time two devices meet that is exactly what tends
 * to fail, which used to strand both sides of a pairing. A message rides
 * inside the offer itself, so pairing asks nothing of the network beyond
 * reaching the mailbox, which both devices have already done by this point.
 * A peer that predates the message form is still sent a file.
 */
export async function completePairingAsScanner(
  payload: PairingPayload,
  myName: string,
  transferId: number
): Promise<PairedDevice> {
  const handshake = encodeHandshake(myName);
  // Only send a message to a device that said it can read one. Anything
  // older - and Symbian - still wants the file, and sending what the peer
  // understands is what keeps pairing across versions working.
  const path = wantsMessageHandshake(payload)
    ? null
    : await pg().writeTemp(PAIRING_HANDSHAKE_FILE, handshake);
  try {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < PAIRED_CODE_ATTEMPTS; attempt += 1) {
      try {
        const code = deriveCode(payload.secret, currentBucket(), attempt);
        if (path === null) {
          await pg().sendText(transferId, handshake, code, currentServer());
        } else {
          await pg().send(transferId, path, code, currentServer());
        }
        return await addDevice(payload.name, payload.secret);
      } catch (e) {
        lastError = e;
        // A message needs no transit, so this should not happen for that
        // reason any more - but a file still can, and then the code it failed
        // on is spent (the nameplate goes the moment the two sides meet), so
        // the next one is where the other side is looking.
        if (!isTransitFailure(e)) throw e;
      }
    }
    throw lastError ?? new Error('pairing failed');
  } finally {
    if (path !== null) pg().deleteFile(path).catch(() => undefined);
  }
}

/** Displayer side: poll derived codes until the peer's handshake arrives. */
export async function waitForPairingAsDisplayer(
  payload: PairingPayload,
  transferId: number,
  isCancelled: () => boolean
): Promise<PairedDevice> {
  const tempDir = await pg().tempDir();
  const deadline = Date.now() + PAIRED_RECEIVE_TIMEOUT_MS;
  // Only a failure from after the peer was found is worth reporting. The
  // rest of the loop is unclaimed codes, which only ever mean "not yet".
  let realError: unknown = null;
  while (Date.now() < deadline && !isCancelled()) {
    for (const code of candidateCodes(payload.secret)) {
      if (isCancelled()) break;
      let offer;
      try {
        // Bounded: a nameplate still held by a sender that died would hold
        // the loop open otherwise.
        offer = await requestReceiveBounded(transferId, code);
      } catch {
        continue;
      }
      // A handshake sent as a message is already here - the engine
      // acknowledged it as it arrived, so there is nothing to accept.
      if (offer.text != null) {
        const message = parseHandshake(offer.text);
        if (message) return await addDevice(message.name, payload.secret);
        realError = new Error('malformed handshake');
        continue;
      }
      try {
        // A peer on 1.3.x still sends the handshake as a file; take it the
        // old way so pairing with one keeps working. Not bounded,
        // deliberately: the two sides have met by now and the nameplate is
        // already released, so cutting the transfer off would strand both of
        // them with nothing left to find.
        const saved = await pg().accept(transferId, tempDir);
        const message = parseHandshake(await pg().readText(saved));
        pg().deleteFile(saved).catch(() => undefined);
        if (message) return await addDevice(message.name, payload.secret);
        realError = new Error('malformed handshake');
      } catch (e) {
        // The peer was here and the handshake failed - transit, usually. It
        // moves on to its next code, which this loop already covers.
        realError = e;
      }
    }
    if (isCancelled()) break;
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), PAIRED_POLL_PAUSE_MS);
    });
  }
  throw realError ?? new Error('pairing timed out');
}
