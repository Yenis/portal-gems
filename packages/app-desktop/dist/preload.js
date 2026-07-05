// src/preload.ts
var import_electron = require("electron");
import_electron.contextBridge.exposeInMainWorld("portalgems", {
  send: () => import_electron.ipcRenderer.invoke("pg-send"),
  recv: (code) => import_electron.ipcRenderer.invoke("pg-recv", code),
  onLog: (cb) => import_electron.ipcRenderer.on("pg-log", (_e, line) => cb(line))
});
