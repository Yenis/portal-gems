// PortalGems desktop: Electron main process. Owns the Rust engine (via the
// napi addon) and exposes a narrow IPC surface to the sandboxed renderer.
// Transfer ids are allocated by the renderer; events stream back on 'pg:event'.

import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { currentBucket, deriveCode } from '@portalgems/core';
import { engine, type NativeTransferEvent, type ServerConfig } from './engine';

let win: BrowserWindow | null = null;

// ---- Paired-device storage: encrypted with the OS keychain when available ----

const pairsPath = () => path.join(app.getPath('userData'), 'paired-devices.bin');

function readPairs(): string {
  try {
    const raw = fs.readFileSync(pairsPath());
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(raw);
    }
    return raw.toString('utf8');
  } catch {
    return '[]';
  }
}

function writePairs(json: string): void {
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, 'utf8');
  fs.writeFileSync(pairsPath(), data);
}

const forward = (id: number) => (ev: NativeTransferEvent) => {
  win?.webContents.send('pg:event', { id, ...ev });
};

// ---- Download destination helpers ----

// Mirrors the engine's sanitize_file_name: the offered name is already
// sanitized by the engine, but the stat check receives it over IPC, so
// defend here too.
function safeFileName(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/'));
  return base === '' || base === '.' || base === '..' ? 'received.bin' : base;
}

/** The folder received files should land in: the user's choice, else Downloads. */
const resolveDownloadDir = (dir?: string | null) =>
  dir && dir.trim() !== '' ? dir : app.getPath('downloads');

/** First free `name`, `name (1)`, `name (2)`, … inside `dir` (engine convention). */
function dedupPath(dir: string, name: string): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let dest = path.join(dir, name);
  for (let n = 1; fs.existsSync(dest); n++) {
    dest = path.join(dir, `${stem} (${n})${ext}`);
  }
  return dest;
}

/** Move across filesystems if needed; lands at `dest` via an atomic rename. */
async function moveFile(src: string, dest: string): Promise<void> {
  try {
    await fs.promises.rename(src, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    const part = `${dest}.pgpart`;
    await fs.promises.copyFile(src, part);
    await fs.promises.rename(part, dest);
    await fs.promises.unlink(src);
  }
}

ipcMain.handle('pg:locale', () => app.getLocale());

ipcMain.handle('pg:pickFile', async () => {
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, { properties: ['openFile'] });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const stat = await fs.promises.stat(filePath);
  return { path: filePath, name: path.basename(filePath), size: stat.size };
});

ipcMain.handle(
  'pg:send',
  (_e, id: number, filePath: string, code?: string, server?: ServerConfig) =>
    engine.sendFile(id, filePath, code ?? null, server ?? {}, forward(id))
);

ipcMain.handle(
  'pg:requestReceive',
  (_e, id: number, code: string, server?: ServerConfig) =>
    engine.requestReceive(id, code, server ?? {})
);

// Plain accept into an explicit directory; used by the pairing handshake.
ipcMain.handle('pg:accept', async (_e, id: number, destDir: string) => {
  return engine.acceptReceive(id, destDir, forward(id));
});

// Accept a user-visible download. The transfer lands in a per-transfer
// staging dir first, so the destination - including a file the user agreed
// to overwrite - is only touched after the file has fully arrived. A failed
// or cancelled transfer leaves the existing file untouched.
ipcMain.handle(
  'pg:acceptDownload',
  async (_e, id: number, dir: string | null, overwrite: boolean) => {
    const staging = path.join(app.getPath('userData'), 'incoming', String(id));
    await fs.promises.mkdir(staging, { recursive: true });
    try {
      const saved = await engine.acceptReceive(id, staging, forward(id));
      const destDir = resolveDownloadDir(dir);
      // Recreate the folder if the user deleted it since choosing it.
      await fs.promises.mkdir(destDir, { recursive: true });
      const name = path.basename(saved);
      const dest = overwrite ? path.join(destDir, name) : dedupPath(destDir, name);
      await moveFile(saved, dest);
      return path.basename(dest);
    } finally {
      await fs.promises
        .rm(staging, { recursive: true, force: true })
        .catch(() => undefined);
    }
  }
);

ipcMain.handle('pg:pickDirectory', async () => {
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
});

// Does the incoming file's name collide in the download folder? Checked
// before accepting so the user can decide between overwrite and keep-both.
ipcMain.handle('pg:statTarget', async (_e, dir: string | null, fileName: string) => {
  const target = path.join(resolveDownloadDir(dir), safeFileName(fileName));
  try {
    const st = await fs.promises.stat(target);
    return { exists: st.isFile(), size: st.size };
  } catch {
    return { exists: false, size: 0 };
  }
});

ipcMain.handle('pg:deviceName', () => os.hostname());
ipcMain.handle('pg:tempDir', () => app.getPath('temp'));
ipcMain.handle('pg:pairs:get', () => readPairs());
ipcMain.handle('pg:pairs:set', (_e, json: string) => writePairs(json));
ipcMain.handle('pg:writeTemp', async (_e, name: string, content: string) => {
  const file = path.join(app.getPath('temp'), name);
  await fs.promises.writeFile(file, content, 'utf8');
  return file;
});
ipcMain.handle('pg:readText', (_e, p: string) => fs.promises.readFile(p, 'utf8'));
ipcMain.handle('pg:deleteFile', (_e, p: string) =>
  fs.promises.unlink(p).catch(() => undefined)
);

ipcMain.handle('pg:reject', (_e, id: number) => engine.rejectReceive(id));

ipcMain.handle('pg:cancel', (_e, id: number) => engine.cancelTransfer(id));

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 620,
    height: 760,
    minWidth: 480,
    minHeight: 560,
    title: 'PortalGems',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));

  // Dev-only smoke harness: drives the real renderer UI end-to-end.
  //   PG_SMOKE_RECEIVE=<code>        receive flow incl. Accept
  //   PG_SMOKE_RECEIVE_CANCEL=<code> receive flow, Cancel while connecting
  const smokeReceive = process.env.PG_SMOKE_RECEIVE;
  const smokeCancel = process.env.PG_SMOKE_RECEIVE_CANCEL;
  if (smokeReceive || smokeCancel) {
    runSmoke(smokeReceive ?? smokeCancel!, Boolean(smokeCancel)).catch((e) => {
      console.log(`SMOKE:ERROR:${e}`);
      app.exit(1);
    });
  }
  if (process.env.PG_SMOKE_PAIR_SHOW) {
    runSmokePairShow().catch((e) => {
      console.log(`SMOKE:ERROR:${e}`);
      app.exit(1);
    });
  }
  if (process.env.PG_SMOKE_PAIRED_RECEIVE) {
    runSmokePairedReceive().catch((e) => {
      console.log(`SMOKE:ERROR:${e}`);
      app.exit(1);
    });
  }
  if (process.env.PG_SMOKE_PAIRED_SEND) {
    runSmokePairedSend(process.env.PG_SMOKE_PAIRED_SEND).catch((e) => {
      console.log(`SMOKE:ERROR:${e}`);
      app.exit(1);
    });
  }
});

// ---- smoke helpers (dev only) ----

const smokeExec = <T>(js: string): Promise<T> => win!.webContents.executeJavaScript(js);
const smokeClick = (label: string) =>
  smokeExec(
    `[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(label)})?.click() ?? 'missing'`
  );
const smokeWaitFor = async (needle: string, timeoutMs: number) => {
  const start = Date.now();
  for (;;) {
    const text = await smokeExec<string>('document.body.innerText');
    if (text.includes(needle)) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for "${needle}"; body: ${text.slice(0, 300)}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
};

async function runSmokePairShow() {
  await smokeWaitFor('PortalGems', 10000);
  await smokeClick('Pair a new device');
  await smokeWaitFor('Show pairing code', 5000);
  await smokeClick('Show pairing code');
  await smokeWaitFor('Copy pairing code', 10000);
  await smokeClick('Copy pairing code');
  await new Promise((r) => setTimeout(r, 300));
  console.log(`PAIR-PAYLOAD:${clipboard.readText()}`);
  await smokeWaitFor('Paired with', 120000);
  console.log('SMOKE:PAIRED-OK');
  app.exit(0);
}

async function runSmokePairedReceive() {
  await smokeWaitFor('PortalGems', 10000);
  await smokeClick('Receive'); // first device row's Receive button
  await smokeWaitFor('Do you want to receive this file?', 90000);
  console.log('SMOKE:PAIRED-CONFIRM');
  await smokeClick('Accept');
  await smokeWaitFor('Saved to Downloads', 90000);
  console.log('SMOKE:PAIRED-RECEIVE-OK');
  app.exit(0);
}

/// Smoke tests can target a reachable server via env (the public default is
/// often down), e.g. a locally-run mailbox + transit relay.
function smokeServer(): ServerConfig {
  return {
    rendezvousUrl: process.env.PG_SMOKE_RENDEZVOUS || undefined,
    transitUrl: process.env.PG_SMOKE_TRANSIT || undefined,
  };
}

async function runSmokePairedSend(filePath: string) {
  const devices = JSON.parse(readPairs());
  if (!Array.isArray(devices) || devices.length === 0) {
    throw new Error('no paired devices');
  }
  const code = deriveCode(devices[0].secret, currentBucket());
  await engine.sendFile(990, filePath, code, smokeServer(), (ev) =>
    console.log(`SMOKE-EV:${ev.event}:${ev.info ?? ''}`)
  );
  console.log('SMOKE:PAIRED-SEND-OK');
  app.exit(0);
}

async function runSmoke(code: string, cancelInstead: boolean) {
  const exec = <T>(js: string): Promise<T> => win!.webContents.executeJavaScript(js);
  const bodyText = () => exec<string>('document.body.innerText');
  const clickButton = (label: string) =>
    exec(
      `[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(label)})?.click() ?? 'missing'`
    );
  const waitFor = async (needle: string, timeoutMs: number) => {
    const start = Date.now();
    for (;;) {
      const text = await bodyText();
      if (text.includes(needle)) return;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timed out waiting for "${needle}"; body: ${text.slice(0, 300)}`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  };

  await waitFor('PortalGems', 10000);
  // Optional: receive into a custom download folder instead of Downloads.
  // Always clear otherwise - the smoke profile persists across runs.
  const dlDir = process.env.PG_SMOKE_DL_DIR;
  await exec(
    dlDir
      ? `localStorage.setItem('pg-download-dir', ${JSON.stringify(dlDir)})`
      : `localStorage.removeItem('pg-download-dir')`
  );
  await exec(`(() => {
    const input = document.querySelector('input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(code)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await clickButton('Receive');
  if (cancelInstead) {
    await new Promise((r) => setTimeout(r, 500));
    await clickButton('Cancel');
    await waitFor('Transfer cancelled', 15000);
    console.log('SMOKE:CANCELLED-OK');
  } else {
    await waitFor('Do you want to receive this file?', 45000);
    console.log('SMOKE:CONFIRM-VISIBLE');
    await clickButton('Accept');
    // Optional: expect the same-name warning and resolve it.
    //   PG_SMOKE_CONFLICT=overwrite | keepboth
    const conflict = process.env.PG_SMOKE_CONFLICT;
    if (conflict) {
      await waitFor('File already exists', 15000);
      console.log('SMOKE:CONFLICT-VISIBLE');
      await clickButton(conflict === 'overwrite' ? 'Overwrite' : 'Keep both');
    }
    await waitFor(dlDir ? 'Saved as' : 'Saved to Downloads', 90000);
    console.log('SMOKE:RECEIVE-OK');
  }
  app.exit(0);
}

app.on('window-all-closed', () => app.quit());
