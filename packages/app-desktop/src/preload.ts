import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('portalgems', {
  send: () => ipcRenderer.invoke('pg-send'),
  recv: (code: string) => ipcRenderer.invoke('pg-recv', code),
  onLog: (cb: (line: string) => void) =>
    ipcRenderer.on('pg-log', (_e, line: string) => cb(line)),
});
