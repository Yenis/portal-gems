var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/main.ts
var import_electron = require("electron");
var path2 = __toESM(require("node:path"));

// src/engine.ts
var import_node_module = require("node:module");
var path = __toESM(require("node:path"));
var requireNative = (0, import_node_module.createRequire)(__filename);
var native = requireNative(
  process.env.PG_ADDON_PATH ?? path.join(__dirname, "wormhole_node.node")
);
function dispatch(listener) {
  return (ev) => {
    if (ev.event === "code") listener.onCode(ev.code ?? "");
    else if (ev.event === "transit") listener.onTransit(ev.info ?? "");
    else if (ev.event === "progress") listener.onProgress(ev.done ?? 0, ev.total ?? 0);
  };
}
function sendFile(filePath, code, listener) {
  return native.sendFile(filePath, code ?? null, dispatch(listener));
}
function receiveFile(code, destDir, listener) {
  return native.receiveFile(code, destDir, dispatch(listener));
}
function createTestFile(dir, sizeKb) {
  return native.createTestFile(dir, sizeKb);
}

// src/main.ts
var win = null;
function log(line) {
  console.log(line);
  win?.webContents.send("pg-log", line);
}
function makeListener() {
  let lastPct = -1;
  return {
    onCode: (code) => log(`CODE:${code}`),
    onTransit: (info) => log(`TRANSIT:${info}`),
    onProgress: (done, total) => {
      const pct = total === 0 ? 100 : Math.floor(done / total * 100);
      if (pct >= lastPct + 25 || pct === 100) {
        lastPct = pct;
        log(`PROGRESS:${pct}`);
      }
    }
  };
}
async function doSend(code) {
  const file = createTestFile(import_electron.app.getPath("temp"), 256);
  log(`created ${file}`);
  await sendFile(file, code, makeListener());
  log("SEND-OK");
}
async function doRecv(code) {
  const saved = await receiveFile(code, import_electron.app.getPath("downloads"), makeListener());
  log(`RECV-OK:${saved}`);
}
import_electron.ipcMain.handle("pg-send", () => doSend().catch((e) => log(`ERROR:${e}`)));
import_electron.ipcMain.handle(
  "pg-recv",
  (_e, code) => doRecv(code).catch((e) => log(`ERROR:${e}`))
);
import_electron.app.whenReady().then(async () => {
  win = new import_electron.BrowserWindow({
    width: 560,
    height: 680,
    title: "PortalGems \u2014 Phase 0",
    webPreferences: {
      preload: path2.join(__dirname, "preload.js"),
      contextIsolation: true
    }
  });
  await win.loadFile(path2.join(__dirname, "..", "src", "renderer", "index.html"));
  const arg = (prefix) => process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
  try {
    const sendCode = arg("--auto-send-code=");
    const recvCode = arg("--auto-recv=");
    if (sendCode) {
      await doSend(sendCode);
      import_electron.app.exit(0);
    } else if (recvCode) {
      await doRecv(recvCode);
      import_electron.app.exit(0);
    } else if (process.argv.includes("--auto-send")) {
      await doSend();
      import_electron.app.exit(0);
    }
  } catch (e) {
    log(`ERROR:${e}`);
    import_electron.app.exit(1);
  }
});
import_electron.app.on("window-all-closed", () => import_electron.app.quit());
