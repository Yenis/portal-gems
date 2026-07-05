// Desktop engine wrapper: loads the napi-rs addon (native/wormhole-node) and
// presents the same listener-shaped API the Android app gets from its
// generated bindings. The addon crosses the FFI with strings/numbers only,
// which keeps it compatible with Electron's V8 memory cage.

import { createRequire } from 'node:module';
import * as path from 'node:path';

interface NativeTransferEvent {
  event: 'code' | 'transit' | 'progress';
  code?: string;
  info?: string;
  done?: number;
  total?: number;
}

interface NativeAddon {
  sendFile(
    path: string,
    code: string | null,
    cb: (ev: NativeTransferEvent) => void
  ): Promise<void>;
  receiveFile(
    code: string,
    destDir: string,
    cb: (ev: NativeTransferEvent) => void
  ): Promise<string>;
  createTestFile(dir: string, sizeKb: number): string;
}

const requireNative = createRequire(__filename);
const native: NativeAddon = requireNative(
  process.env.PG_ADDON_PATH ?? path.join(__dirname, 'wormhole_node.node')
);

export interface TransferListener {
  onCode(code: string): void;
  onTransit(info: string): void;
  onProgress(done: number, total: number): void;
}

function dispatch(listener: TransferListener) {
  return (ev: NativeTransferEvent) => {
    if (ev.event === 'code') listener.onCode(ev.code ?? '');
    else if (ev.event === 'transit') listener.onTransit(ev.info ?? '');
    else if (ev.event === 'progress') listener.onProgress(ev.done ?? 0, ev.total ?? 0);
  };
}

export function sendFile(
  filePath: string,
  code: string | undefined,
  listener: TransferListener
): Promise<void> {
  return native.sendFile(filePath, code ?? null, dispatch(listener));
}

export function receiveFile(
  code: string,
  destDir: string,
  listener: TransferListener
): Promise<string> {
  return native.receiveFile(code, destDir, dispatch(listener));
}

export function createTestFile(dir: string, sizeKb: number): string {
  return native.createTestFile(dir, sizeKb);
}
