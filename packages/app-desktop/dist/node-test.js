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

// src/node-test.ts
var os = __toESM(require("node:os"));

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

// src/node-test.ts
function makeListener() {
  let lastPct = -1;
  return {
    onCode: (code) => console.log(`CODE:${code}`),
    onTransit: (info) => console.log(`TRANSIT:${info}`),
    onProgress: (done, total) => {
      const pct = total === 0 ? 100 : Math.floor(done / total * 100);
      if (pct >= lastPct + 25 || pct === 100) {
        lastPct = pct;
        console.log(`PROGRESS:${pct}`);
      }
    }
  };
}
async function main() {
  const [mode, a, b] = process.argv.slice(2);
  if (mode === "send") {
    const file = createTestFile(os.tmpdir(), 256);
    console.log(`created ${file}`);
    await sendFile(file, a, makeListener());
    console.log("SEND-OK");
  } else if (mode === "recv") {
    const saved = await receiveFile(a, b ?? ".", makeListener());
    console.log(`RECV-OK:${saved}`);
  } else {
    throw new Error("usage: node-test send [code] | recv <code> [destDir]");
  }
}
main().then(
  () => process.exit(0),
  (e) => {
    console.error(`ERROR:${e}`);
    process.exit(1);
  }
);
