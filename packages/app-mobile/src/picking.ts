import { pick } from '@react-native-documents/picker';
import { bundleEntryNames, planSend } from '@portalgems/core';
import { copyToCache, type SendItem } from './native';

/**
 * Open the system file picker and turn what was chosen into something to
 * send. The picker is the whole selection: one file comes back as a file and
 * is sent exactly as a single file always was, several come back as a bundle
 * sent in one transfer, and there is no adding to it afterwards.
 *
 * Rejects when the picker is closed (`code: 'OPERATION_CANCELED'`) or a file
 * cannot be read, as `pick` itself does.
 */
export async function pickFilesToSend(): Promise<SendItem> {
  const picked = await pick({ allowMultiSelection: true });
  return itemFromUris(
    picked.map((file) => file.uri),
    picked.map((file) => file.name)
  );
}

/**
 * The same decision for URIs that arrived another way - a share from another
 * app. `names` are whatever their sources call them, in the same order.
 */
export async function itemFromUris(
  uris: string[],
  names: (string | null | undefined)[]
): Promise<SendItem> {
  const plan = planSend(uris.map(() => ({ isFolder: false })));
  if (plan === 'nothing') throw new Error('nothing was picked');
  if (plan === 'bundle') {
    return { kind: 'bundle', uris, names: bundleEntryNames(names) };
  }
  // One file: copied into the cache now, where the engine can read it.
  return { kind: 'file', ...(await copyToCache(uris[0])) };
}
