// Gate 3 harness: exercise the generated bindings under plain Node (no Electron).
// Usage: node dist/node-test.js send [code] | recv <code> <destDir>

import * as os from 'node:os';
import {
  createTestFile,
  receiveFile,
  sendFile,
  type TransferListener,
} from './engine';

function makeListener(): TransferListener {
  let lastPct = -1;
  return {
    onCode: (code) => console.log(`CODE:${code}`),
    onTransit: (info) => console.log(`TRANSIT:${info}`),
    onProgress: (done, total) => {
      const pct = total === 0 ? 100 : Math.floor((done / total) * 100);
      if (pct >= lastPct + 25 || pct === 100) {
        lastPct = pct;
        console.log(`PROGRESS:${pct}`);
      }
    },
  };
}

async function main() {
  const [mode, a, b] = process.argv.slice(2);
  if (mode === 'send') {
    const file = createTestFile(os.tmpdir(), 256);
    console.log(`created ${file}`);
    await sendFile(file, a, makeListener());
    console.log('SEND-OK');
  } else if (mode === 'recv') {
    const saved = await receiveFile(a!, b ?? '.', makeListener());
    console.log(`RECV-OK:${saved}`);
  } else {
    throw new Error('usage: node-test send [code] | recv <code> [destDir]');
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`ERROR:${e}`);
    process.exit(1);
  }
);
