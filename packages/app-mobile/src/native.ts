import { NativeModules, PermissionsAndroid, Platform } from 'react-native';

export interface PickedFile {
  path: string;
  name: string;
  size: number;
}

interface PortalGemsNativeSpec {
  incomingDir: string;
  copyToCache(uri: string): Promise<PickedFile>;
  saveToDownloads(srcPath: string, fileName: string): Promise<string>;
  startTransferService(title: string): Promise<void>;
  stopTransferService(): Promise<void>;
}

const native = NativeModules.PortalGemsNative as PortalGemsNativeSpec;

export const incomingDir: string = native.incomingDir;
export const copyToCache = (uri: string) => native.copyToCache(uri);
export const saveToDownloads = (srcPath: string, fileName: string) =>
  native.saveToDownloads(srcPath, fileName);

/** Hold the foreground service for the duration of `work`. */
export async function withTransferService<T>(
  title: string,
  work: () => Promise<T>
): Promise<T> {
  if (Platform.OS === 'android' && Platform.Version >= 33) {
    // Without this the service still runs; the user just sees no notification.
    await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
    ).catch(() => undefined);
  }
  await native.startTransferService(title).catch(() => undefined);
  try {
    return await work();
  } finally {
    await native.stopTransferService().catch(() => undefined);
  }
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
