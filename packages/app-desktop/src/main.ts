// PortalGems Phase 0 desktop spike: Electron main process driving the same
// generated wormhole-core bindings the Android app uses (via @ubjs/node).
//
// Automation flags (used by the gate-3 test harness; logs mirror to stdout):
//   --auto-send              send a generated test file, print CODE:, exit
//   --auto-send-code=<code>  same, but on a fixed (paired-style) code
//   --auto-recv=<code>       receive into the downloads dir and exit

import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'node:path';
import {
  createTestFile,
  receiveFile,
  sendFile,
  type TransferListener,
} from './engine';

let win: BrowserWindow | null = null;

function log(line: string) {
  console.log(line);
  win?.webContents.send('pg-log', line);
}

function makeListener(): TransferListener {
  let lastPct = -1;
  return {
    onCode: (code) => log(`CODE:${code}`),
    onTransit: (info) => log(`TRANSIT:${info}`),
    onProgress: (done, total) => {
      const pct = total === 0 ? 100 : Math.floor((done / total) * 100);
      if (pct >= lastPct + 25 || pct === 100) {
        lastPct = pct;
        log(`PROGRESS:${pct}`);
      }
    },
  };
}

async function doSend(code?: string) {
  const file = createTestFile(app.getPath('temp'), 256);
  log(`created ${file}`);
  await sendFile(file, code, makeListener());
  log('SEND-OK');
}

async function doRecv(code: string) {
  const saved = await receiveFile(code, app.getPath('downloads'), makeListener());
  log(`RECV-OK:${saved}`);
}

ipcMain.handle('pg-send', () => doSend().catch((e) => log(`ERROR:${e}`)));
ipcMain.handle('pg-recv', (_e, code: string) =>
  doRecv(code).catch((e) => log(`ERROR:${e}`))
);

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 560,
    height: 680,
    title: 'PortalGems — Phase 0',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));

  const arg = (prefix: string) =>
    process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);

  try {
    const sendCode = arg('--auto-send-code=');
    const recvCode = arg('--auto-recv=');
    if (sendCode) {
      await doSend(sendCode);
      app.exit(0);
    } else if (recvCode) {
      await doRecv(recvCode);
      app.exit(0);
    } else if (process.argv.includes('--auto-send')) {
      await doSend();
      app.exit(0);
    }
  } catch (e) {
    log(`ERROR:${e}`);
    app.exit(1);
  }
});

app.on('window-all-closed', () => app.quit());
