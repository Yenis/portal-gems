"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/preload.ts
var preload_exports = {};
module.exports = __toCommonJS(preload_exports);
var import_electron = require("electron");
import_electron.contextBridge.exposeInMainWorld("portalgems", {
  locale: () => import_electron.ipcRenderer.invoke("pg:locale"),
  pickFile: () => import_electron.ipcRenderer.invoke("pg:pickFile"),
  send: (id, path, code, server) => import_electron.ipcRenderer.invoke("pg:send", id, path, code, server),
  requestReceive: (id, code, server) => import_electron.ipcRenderer.invoke("pg:requestReceive", id, code, server),
  accept: (id, destDir) => import_electron.ipcRenderer.invoke("pg:accept", id, destDir),
  acceptDownload: (id, dir, overwrite) => import_electron.ipcRenderer.invoke("pg:acceptDownload", id, dir, overwrite),
  pickDirectory: () => import_electron.ipcRenderer.invoke("pg:pickDirectory"),
  statTarget: (dir, fileName) => import_electron.ipcRenderer.invoke("pg:statTarget", dir, fileName),
  reject: (id) => import_electron.ipcRenderer.invoke("pg:reject", id),
  cancel: (id) => import_electron.ipcRenderer.invoke("pg:cancel", id),
  deviceName: () => import_electron.ipcRenderer.invoke("pg:deviceName"),
  tempDir: () => import_electron.ipcRenderer.invoke("pg:tempDir"),
  pairsGet: () => import_electron.ipcRenderer.invoke("pg:pairs:get"),
  pairsSet: (json) => import_electron.ipcRenderer.invoke("pg:pairs:set", json),
  writeTemp: (name, content) => import_electron.ipcRenderer.invoke("pg:writeTemp", name, content),
  readText: (path) => import_electron.ipcRenderer.invoke("pg:readText", path),
  deleteFile: (path) => import_electron.ipcRenderer.invoke("pg:deleteFile", path),
  onEvent: (cb) => {
    import_electron.ipcRenderer.on("pg:event", (_e, ev) => cb(ev));
  }
});
