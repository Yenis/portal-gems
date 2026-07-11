import { NativeModules, PermissionsAndroid, Platform } from 'react-native';

export interface PickedFile {
  path: string;
  name: string;
  size: number;
}

interface PortalGemsNativeSpec {
  incomingDir: string;
  cacheDir: string;
  deviceName: string;
  locale: string;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  copyToCache(uri: string): Promise<PickedFile>;
  saveToDownloads(srcPath: string, fileName: string): Promise<string>;
  consumePendingShare(): Promise<string | null>;
  startTransferService(title: string): Promise<void>;
  stopTransferService(): Promise<void>;
  getPairedDevices(): Promise<string>;
  setPairedDevices(json: string): Promise<void>;
  scanQr(): Promise<string | null>;
  writeTextFile(dir: string, name: string, content: string): Promise<string>;
  readTextFile(path: string): Promise<string>;
  deleteFile(path: string): Promise<void>;
}

const native = NativeModules.PortalGemsNative as PortalGemsNativeSpec;

export const incomingDir: string = native.incomingDir;
export const cacheDir: string = native.cacheDir;
export const deviceName: string = native.deviceName;
export const deviceLocale: string = native.locale;
export const getSetting = (key: string) => native.getSetting(key);
export const setSetting = (key: string, value: string) =>
  native.setSetting(key, value);
export const copyToCache = (uri: string) => native.copyToCache(uri);
export const consumePendingShare = () => native.consumePendingShare();
export const getPairedDevicesJson = () => native.getPairedDevices();
export const setPairedDevicesJson = (json: string) => native.setPairedDevices(json);
export const scanQr = () => native.scanQr();
export const writeTextFile = (dir: string, name: string, content: string) =>
  native.writeTextFile(dir, name, content);
export const readTextFile = (path: string) => native.readTextFile(path);
export const deleteFile = (path: string) => native.deleteFile(path);
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
