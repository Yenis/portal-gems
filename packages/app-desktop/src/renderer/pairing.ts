// Desktop pairing glue (renderer side). Mirrors app-mobile/src/pairing.ts;
// the protocol logic lives in @portalgems/core, engine access goes over IPC.

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
import { currentServer } from './server';

const pg = () => window.portalgems;

export async function loadDevices(): Promise<PairedDevice[]> {
  try {
    const parsed = JSON.parse(await pg().pairsGet());
    return Array.isArray(parsed) ? parsed : [];
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

export async function removeDevice(id: string): Promise<void> {
  const devices = await loadDevices();
  await saveDevices(devices.filter((d) => d.id !== id));
}

/** Scanner/paster side: send our device name over the derived code. */
export async function completePairingAsScanner(
  payload: PairingPayload,
  myName: string,
  transferId: number
): Promise<PairedDevice> {
  const path = await pg().writeTemp(PAIRING_HANDSHAKE_FILE, encodeHandshake(myName));
  try {
    const code = deriveCode(payload.secret, currentBucket());
    await pg().send(transferId, path, code, currentServer());
    return await addDevice(payload.name, payload.secret);
  } finally {
    pg().deleteFile(path).catch(() => undefined);
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
  let lastError: unknown = new Error('pairing timed out');
  while (Date.now() < deadline && !isCancelled()) {
    for (const bucket of candidateBuckets()) {
      if (isCancelled()) break;
      try {
        const code = deriveCode(payload.secret, bucket);
        await pg().requestReceive(transferId, code, currentServer());
        const saved = await pg().accept(transferId, tempDir);
        const message = parseHandshake(await pg().readText(saved));
        pg().deleteFile(saved).catch(() => undefined);
        if (message) return await addDevice(message.name, payload.secret);
        lastError = new Error('malformed handshake');
      } catch (e) {
        lastError = e;
      }
    }
  }
  throw lastError;
}
