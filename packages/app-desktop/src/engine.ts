// Desktop engine wrapper: loads the napi-rs addon (native/wormhole-node) and
// presents a typed API over its id-registry model. The addon crosses the FFI
// with strings/numbers only, keeping it compatible with Electron's V8 memory
// cage (see docs/phase0-desktop-notes.md).

import { createRequire } from 'node:module';
import * as path from 'node:path';

export interface NativeTransferEvent {
  event: 'code' | 'transit' | 'progress';
  code?: string;
  info?: string;
  done?: number;
  total?: number;
}

export interface FileOffer {
  fileName: string;
  fileSize: number;
}

interface NativeAddon {
  sendFile(
    id: number,
    path: string,
    code: string | null,
    cb: (ev: NativeTransferEvent) => void
  ): Promise<void>;
  requestReceive(id: number, code: string): Promise<FileOffer>;
  acceptReceive(
    id: number,
    destDir: string,
    cb: (ev: NativeTransferEvent) => void
  ): Promise<string>;
  rejectReceive(id: number): Promise<void>;
  cancelTransfer(id: number): void;
  createTestFile(dir: string, sizeKb: number): string;
}

// Prefer a platform-suffixed addon (multi-platform packaging), fall back to
// the plain name produced by dev builds.
const requireNative = createRequire(__filename);

function loadAddon(): NativeAddon {
  if (process.env.PG_ADDON_PATH) return requireNative(process.env.PG_ADDON_PATH);
  const platformSpecific = path.join(
    __dirname,
    `wormhole_node-${process.platform}-${process.arch}.node`
  );
  try {
    return requireNative(platformSpecific);
  } catch {
    return requireNative(path.join(__dirname, 'wormhole_node.node'));
  }
}

const native: NativeAddon = loadAddon();

export const engine = native;
