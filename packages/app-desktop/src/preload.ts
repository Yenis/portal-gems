import { contextBridge, ipcRenderer } from 'electron';

export interface PgEvent {
  id: number;
  event: 'code' | 'transit' | 'progress';
  code?: string;
  info?: string;
  done?: number;
  total?: number;
}

/// Which servers a transfer should use; empty/missing fields fall back to the
/// public magic-wormhole defaults.
export interface ServerConfig {
  rendezvousUrl?: string;
  transitUrl?: string;
}

contextBridge.exposeInMainWorld('portalgems', {
  locale: (): Promise<string> => ipcRenderer.invoke('pg:locale'),
  pickFile: (): Promise<{ path: string; name: string; size: number } | null> =>
    ipcRenderer.invoke('pg:pickFile'),
  send: (
    id: number,
    path: string,
    code?: string,
    server?: ServerConfig
  ): Promise<void> => ipcRenderer.invoke('pg:send', id, path, code, server),
  requestReceive: (
    id: number,
    code: string,
    server?: ServerConfig
  ): Promise<{ fileName: string; fileSize: number }> =>
    ipcRenderer.invoke('pg:requestReceive', id, code, server),
  accept: (id: number, destDir: string): Promise<string> =>
    ipcRenderer.invoke('pg:accept', id, destDir),
  acceptDownload: (
    id: number,
    dir: string | null,
    overwrite: boolean
  ): Promise<string> => ipcRenderer.invoke('pg:acceptDownload', id, dir, overwrite),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('pg:pickDirectory'),
  statTarget: (
    dir: string | null,
    fileName: string
  ): Promise<{ exists: boolean; size: number }> =>
    ipcRenderer.invoke('pg:statTarget', dir, fileName),
  reject: (id: number): Promise<void> => ipcRenderer.invoke('pg:reject', id),
  cancel: (id: number): Promise<void> => ipcRenderer.invoke('pg:cancel', id),
  deviceName: (): Promise<string> => ipcRenderer.invoke('pg:deviceName'),
  tempDir: (): Promise<string> => ipcRenderer.invoke('pg:tempDir'),
  pairsGet: (): Promise<string> => ipcRenderer.invoke('pg:pairs:get'),
  pairsSet: (json: string): Promise<void> => ipcRenderer.invoke('pg:pairs:set', json),
  writeTemp: (name: string, content: string): Promise<string> =>
    ipcRenderer.invoke('pg:writeTemp', name, content),
  readText: (path: string): Promise<string> => ipcRenderer.invoke('pg:readText', path),
  deleteFile: (path: string): Promise<void> => ipcRenderer.invoke('pg:deleteFile', path),
  onEvent: (cb: (ev: PgEvent) => void) => {
    ipcRenderer.on('pg:event', (_e, ev: PgEvent) => cb(ev));
  },
});
