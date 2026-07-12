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
  PAIRED_RECEIVE_TIMEOUT_MS,
  type PairedDevice,
  type PairingPayload,
} from '@portalgems/core';
import { receiveFile, sendFile } from 'wormhole-rn';
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

export async function removeDevice(id: string): Promise<void> {
  const devices = await loadDevices();
  await saveDevices(devices.filter((d) => d.id !== id));
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
        const saved = await receiveFile(code, incomingDir, server, quietListener, {
          signal,
        });
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
