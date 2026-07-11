# Phase 0 gate 3 - Desktop (Electron) build notes

Verified 2026-07-05 on Linux x64 (Electron 38):

- Electron **send** → CLI `wormhole receive`: ✔ checksum-identical
- CLI `wormhole send` → Electron **receive** into `~/Downloads`: ✔ checksum-identical
- **Electron ↔ Android app (emulator), both directions**: ✔ checksum-identical —
  the plan's headline "laptop app ↔ phone app" scenario
- Direct (non-relay) transit in every run

## Key architectural finding: Electron's V8 memory cage

We first tried ubrn's new Node.js target (`ubrn generate napi` + the `@ubjs/node`
libffi runtime, available as of exactly our version 0.31.0-3). It would have given
desktop the *same generated TypeScript API* as Android. Result:

- **Plain Node 22: works perfectly** (verified with a real transfer).
- **Electron: fails** with `Error: Failed to create external ArrayBuffer` - the
  V8 memory cage forbids externally-backed ArrayBuffers, which `@ubjs/node` uses
  for zero-copy RustBuffers.
- **`ELECTRON_RUN_AS_NODE=1` also fails** - the cage is compiled into Electron's
  binary, so a "sidecar via Electron-as-Node" architecture doesn't dodge it either.

Decision: desktop uses a **napi-rs addon** (`native/wormhole-node`), as the plan
originally called for. It is cage-safe by construction: only strings and f64
numbers cross the FFI boundary (events as `{event, code?, info?, done?, total?}`
objects). If ubrn later ships a cage-safe buffer strategy, revisit for API parity.

## Layout

- `native/wormhole-node` - napi-rs `cdylib` over `wormhole-core` (~100 lines):
  `sendFile`, `receiveFile`, `createTestFile`, threadsafe-function event callback.
- `packages/app-desktop` - Electron spike:
  - `src/engine.ts` - loads `dist/wormhole_node.node`, exposes the same
    listener-shaped API the Android app gets from its generated bindings.
  - `src/main.ts` - main process; IPC handlers + `--auto-send`,
    `--auto-send-code=<code>`, `--auto-recv=<code>` automation flags (logs mirror
    to stdout; used by the gate-3 harness).
  - `src/preload.ts`, `src/renderer/` - minimal UI mirroring the Android spike.
  - `src/node-test.ts` - same engine under plain Node, no Electron needed.

## Build & run

```sh
cd packages/app-desktop
npm install
npm run build        # esbuild bundle + cargo build of the addon (cargo on PATH)
npx electron . --no-sandbox
```

Gotchas:

- **VS Code terminals export `ELECTRON_RUN_AS_NODE=1`**, which makes
  `require('electron')` return the path stub and everything breaks confusingly.
  Launch with `env -u ELECTRON_RUN_AS_NODE npx electron .`.
- The addon is copied to `dist/wormhole_node.node` by `npm run build:native`;
  override the load path with `PG_ADDON_PATH` if needed.
- Packaging (electron-builder, per-platform addon builds, code signing) is
  Phase 2 / Phase 5 work; nothing here addresses it yet.
