import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import QRCodeLib from 'qrcode';
import {
  createPairingPayload,
  currentBucket,
  candidateBuckets,
  deriveCode,
  encodePairingPayload,
  fontSize,
  friendlyError,
  isServerUnreachableError,
  parsePairingPayload,
  spacing,
  PAIRED_RECEIVE_TIMEOUT_MS,
  PAIRED_SEND_TIMEOUT_MS,
  availableServerChoices,
  isCustomServerUsable,
  type PairedDevice,
  type Palette,
  type ServerChoice,
  type ServerConfig,
  type ServerSettings,
} from '@portalgems/core';
import {
  setLanguage,
  themes,
  SUPPORTED_LANGUAGES,
  THEME_NAMES,
  type ThemeName,
} from '@portalgems/core';
import {
  completePairingAsScanner,
  loadDevices,
  removeDevice,
  waitForPairingAsDisplayer,
} from './pairing';
import { loadThemeName, saveThemeName } from './theme';
import { currentServer, loadServerSettings, saveServerSettings } from './server';
import { loadDownloadDir, saveDownloadDir } from './downloads';
import { loadLastSendDir, rememberSendLocation } from './sendlocation';
import {
  Card,
  CodeBox,
  Dropdown,
  GhostButton,
  Muted,
  PrimaryButton,
  ProgressBar,
  Subtitle,
  TextInput,
  Title,
} from './components';
import { formatSize, usePalette } from './theme';
import type { PgEvent } from '../preload';

declare global {
  interface Window {
    portalgems: {
      locale(): Promise<string>;
      pickFile(
        defaultDir?: string | null
      ): Promise<{ path: string; name: string; size: number } | null>;
      pickFolder(defaultDir?: string | null): Promise<{
        path: string;
        name: string;
        fileCount: number;
        totalBytes: number;
      } | null>;
      send(
        id: number,
        path: string,
        code?: string,
        server?: ServerConfig
      ): Promise<void>;
      sendFolder(
        id: number,
        path: string,
        code?: string,
        server?: ServerConfig
      ): Promise<void>;
      requestReceive(
        id: number,
        code: string,
        server?: ServerConfig
      ): Promise<ReceiveOffer>;
      accept(id: number, destDir: string): Promise<string>;
      acceptDownload(
        id: number,
        dir: string | null,
        overwrite: boolean
      ): Promise<string>;
      pickDirectory(): Promise<string | null>;
      downloadDirValid(dir: string | null): Promise<boolean>;
      statTarget(
        dir: string | null,
        fileName: string
      ): Promise<{ exists: boolean; size: number; isFolder: boolean }>;
      reject(id: number): Promise<void>;
      cancel(id: number): Promise<void>;
      deviceName(): Promise<string>;
      tempDir(): Promise<string>;
      pairsGet(): Promise<string>;
      pairsSet(json: string): Promise<void>;
      writeTemp(name: string, content: string): Promise<string>;
      readText(path: string): Promise<string>;
      deleteFile(path: string): Promise<void>;
      onEvent(cb: (ev: PgEvent) => void): void;
    };
  }
}

/** What the user picked to send: a single file, or a whole folder. */
type SendItem =
  | { kind: 'file'; path: string; name: string; size: number }
  | { kind: 'folder'; path: string; name: string; fileCount: number; totalBytes: number };

/** The sender's offer; `folder` is set for folder (directory) offers. */
interface ReceiveOffer {
  fileName: string;
  fileSize: number;
  folder?: { dirName: string; numFiles: number; numBytes: number } | null;
}

const CODE_RE = /^\d+(-[a-zA-Z0-9]+)+$/;
let nextId = 1;

// Per-transfer event fan-out: screens register a handler for their id.
const handlers = new Map<number, (ev: PgEvent) => void>();
window.portalgems.onEvent((ev) => handlers.get(ev.id)?.(ev));

type Route =
  | { name: 'home' }
  | { name: 'send'; item: SendItem; device?: PairedDevice }
  | { name: 'receive'; code?: string; device?: PairedDevice }
  | { name: 'pair' }
  | { name: 'settings'; scrollToServer?: boolean }
  | { name: 'explain' };

export default function App() {
  const [themeName, setThemeNameState] = useState<ThemeName>(loadThemeName());
  const c = usePalette(themeName);
  // Self-heal a stale download-folder setting: a path that no longer makes
  // sense as a download location (e.g. a temp/scratchpad dir left by an
  // automated run) is cleared so receives fall back to the OS Downloads
  // folder. Runs once at startup, before any receive screen mounts.
  useEffect(() => {
    const stored = loadDownloadDir();
    if (!stored) return;
    window.portalgems.downloadDirValid(stored).then((valid) => {
      if (!valid) saveDownloadDir(null);
    });
  }, []);
  // History stack so the back arrow pops one page at a time.
  const [stack, setStack] = useState<Route[]>([{ name: 'home' }]);
  const route = stack[stack.length - 1];
  const navigate = (r: Route) => setStack((s) => [...s, r]);
  const goBack = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  const setThemeName = (name: ThemeName) => {
    setThemeNameState(name);
    saveThemeName(name);
  };

  return (
    <div
      style={{
        background: c.background,
        minHeight: '100vh',
        padding: spacing(6),
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: spacing(5),
      }}>
      {route.name === 'home' ? (
        <Home
          c={c}
          onSend={(item, device) => navigate({ name: 'send', item, device })}
          onReceive={(code) => navigate({ name: 'receive', code })}
          onReceiveFrom={(device) => navigate({ name: 'receive', device })}
          onPair={() => navigate({ name: 'pair' })}
          onSettings={() => navigate({ name: 'settings' })}
          onExplain={() => navigate({ name: 'explain' })}
        />
      ) : route.name === 'send' ? (
        <Send
          c={c}
          item={route.item}
          device={route.device}
          onHome={goBack}
          onServerSettings={() => navigate({ name: 'settings', scrollToServer: true })}
        />
      ) : route.name === 'receive' ? (
        <Receive c={c} code={route.code} device={route.device} onHome={goBack} />
      ) : route.name === 'settings' ? (
        <Settings
          c={c}
          themeName={themeName}
          onTheme={setThemeName}
          onHome={goBack}
          scrollToServer={route.scrollToServer}
        />
      ) : route.name === 'explain' ? (
        <Explain c={c} onHome={goBack} />
      ) : (
        <Pair c={c} onHome={goBack} />
      )}
    </div>
  );
}

function Home({
  c,
  onSend,
  onReceive,
  onReceiveFrom,
  onPair,
  onSettings,
  onExplain,
}: {
  c: Palette;
  onSend: (item: SendItem, device?: PairedDevice) => void;
  onReceive: (code: string) => void;
  onReceiveFrom: (device: PairedDevice) => void;
  onPair: () => void;
  onSettings: () => void;
  onExplain: () => void;
}) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [devices, setDevices] = useState<PairedDevice[]>([]);

  useEffect(() => {
    loadDevices().then(setDevices);
  }, []);

  const pick = async (device?: PairedDevice) => {
    const file = await window.portalgems.pickFile(loadLastSendDir());
    if (file) {
      rememberSendLocation(file.path);
      onSend({ kind: 'file', ...file }, device);
    }
  };

  const pickFolder = async (device?: PairedDevice) => {
    const folder = await window.portalgems.pickFolder(loadLastSendDir());
    if (folder) {
      rememberSendLocation(folder.path);
      onSend({ kind: 'folder', ...folder }, device);
    }
  };

  const remove = (device: PairedDevice) => {
    if (window.confirm(`${t('devices.remove')}: ${device.name}?`)) {
      removeDevice(device.id).then(() => loadDevices().then(setDevices));
    }
  };

  return (
    <>
      <Title c={c}>{t('app.name')}</Title>
      <Muted c={c}>{t('home.tagline')}</Muted>
      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: spacing(2) }}>
        <a
          onClick={onExplain}
          style={{ color: c.primary, fontWeight: 600, cursor: 'pointer' }}>
          {t('home.explainLink')}
        </a>
        <a
          onClick={onSettings}
          style={{ color: c.primary, fontWeight: 600, cursor: 'pointer' }}>
          {t('home.settingsLink')}
        </a>
      </div>
      <Card c={c}>
        <Subtitle c={c}>{t('home.devicesTitle')}</Subtitle>
        {devices.length === 0 ? <Muted c={c}>{t('home.devicesEmpty')}</Muted> : null}
        {devices.map((device) => (
          <div
            key={device.id}
            style={{ display: 'flex', gap: spacing(2), alignItems: 'center' }}>
            <span
              style={{ flex: 1, color: c.text, fontWeight: 600, overflow: 'hidden' }}>
              {device.name}
            </span>
            <div style={{ width: 110 }}>
              <PrimaryButton
                c={c}
                label={t('devices.send')}
                onClick={() => pick(device)}
              />
            </div>
            <div style={{ width: 110 }}>
              <GhostButton
                c={c}
                label={t('devices.receive')}
                onClick={() => onReceiveFrom(device)}
              />
            </div>
            <div style={{ width: 100 }}>
              <GhostButton
                c={c}
                label={t('devices.remove')}
                danger
                onClick={() => remove(device)}
              />
            </div>
          </div>
        ))}
        <GhostButton c={c} label={t('home.pairNew')} onClick={onPair} />
      </Card>
      <Card c={c}>
        <Subtitle c={c}>{t('home.sendTitle')}</Subtitle>
        <Muted c={c}>{t('home.sendHint')}</Muted>
        <PrimaryButton c={c} label={t('home.sendButton')} onClick={() => pick()} />
        <GhostButton
          c={c}
          label={t('home.sendFolderButton')}
          onClick={() => pickFolder()}
        />
      </Card>
      <Card c={c}>
        <Subtitle c={c}>{t('home.receiveTitle')}</Subtitle>
        <Muted c={c}>{t('home.receiveHint')}</Muted>
        <TextInput
          c={c}
          value={code}
          onChange={setCode}
          placeholder={t('home.receivePlaceholder')}
        />
        <PrimaryButton
          c={c}
          label={t('home.receiveButton')}
          onClick={() => onReceive(code.trim())}
          disabled={!CODE_RE.test(code.trim())}
        />
      </Card>
    </>
  );
}

type SendPhase =
  | 'starting'
  | 'waiting'
  | 'transferring'
  | 'done'
  | 'error'
  | 'cancelled'
  | 'peerNotOpen';

function Send({
  c,
  item,
  device,
  onHome,
  onServerSettings,
}: {
  c: Palette;
  item: SendItem;
  device?: PairedDevice;
  onHome: () => void;
  onServerSettings: () => void;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<SendPhase>('starting');
  const [code, setCode] = useState('');
  const [direct, setDirect] = useState<boolean | null>(null);
  const [pct, setPct] = useState(0);
  const [error, setError] = useState('');
  const [serverErr, setServerErr] = useState(false);
  const [copied, setCopied] = useState(false);
  const idRef = useRef(0);
  const cancelledRef = useRef(false);

  useEffect(() => {
    const id = nextId++;
    idRef.current = id;
    let connected = false;
    let timedOut = false;
    handlers.set(id, (ev) => {
      if (ev.event === 'code') {
        setCode(ev.code ?? '');
        setPhase('waiting');
      } else if (ev.event === 'transit') {
        connected = true;
        setDirect((ev.info ?? '').startsWith('Direct'));
        setPhase('transferring');
      } else if (ev.event === 'progress') {
        setPct(ev.total ? Math.floor(((ev.done ?? 0) / ev.total) * 100) : 100);
      }
    });
    const pairedCode = device ? deriveCode(device.secret, currentBucket()) : undefined;
    const timer = device
      ? setTimeout(() => {
          if (!connected) {
            timedOut = true;
            window.portalgems.cancel(id);
          }
        }, PAIRED_SEND_TIMEOUT_MS)
      : null;
    const start =
      item.kind === 'folder' ? window.portalgems.sendFolder : window.portalgems.send;
    start(id, item.path, pairedCode, currentServer()).then(
      () => setPhase('done'),
      (e) => {
        if (timedOut) setPhase('peerNotOpen');
        else if (cancelledRef.current) setPhase('cancelled');
        else {
          setError(friendlyError(t as any, e));
          setServerErr(isServerUnreachableError(e));
          setPhase('error');
        }
      }
    );
    return () => {
      if (timer) clearTimeout(timer);
      handlers.delete(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancel = () => {
    cancelledRef.current = true;
    window.portalgems.cancel(idRef.current);
  };

  const copy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const busy = phase === 'starting' || phase === 'waiting' || phase === 'transferring';
  const summary =
    item.kind === 'folder'
      ? t('folder.summary', {
          name: item.name,
          count: item.fileCount,
          size: formatSize(item.totalBytes),
        })
      : `${item.name} · ${formatSize(item.size)}`;

  return (
    <>
      <Title c={c} onBack={onHome}>{t('send.title')}</Title>
      <Muted c={c}>{summary}</Muted>
      <Card c={c}>
        {phase === 'starting' ? <Muted c={c}>{t('receive.connecting')}</Muted> : null}
        {phase === 'waiting' ? (
          device ? (
            <Muted c={c}>{t('paired.sendWaiting', { name: device.name })}</Muted>
          ) : (
            <>
              <Subtitle c={c}>{t('send.waitingForReceiver')}</Subtitle>
              <CodeBox c={c} code={code} />
              <PrimaryButton
                c={c}
                label={copied ? t('send.codeCopied') : t('send.copyCode')}
                onClick={copy}
              />
            </>
          )
        ) : null}
        {phase === 'transferring' ? (
          <>
            <Subtitle c={c}>
              {item.kind === 'folder'
                ? t('send.sendingFolder', { name: item.name })
                : t('send.sending', { name: item.name })}
            </Subtitle>
            <Muted c={c}>{direct ? t('transfer.direct') : t('transfer.relay')}</Muted>
            <ProgressBar c={c} pct={pct} />
            <Muted c={c}>{t('transfer.progress', { pct })}</Muted>
          </>
        ) : null}
        {phase === 'done' ? (
          <>
            <Subtitle c={c}>
              {item.kind === 'folder' ? t('send.successFolder') : t('send.success')}
            </Subtitle>
            <p style={{ color: c.success, margin: 0 }}>{summary}</p>
          </>
        ) : null}
        {phase === 'error' ? (
          <>
            <Subtitle c={c}>{t('errors.title')}</Subtitle>
            <p style={{ color: c.danger, margin: 0 }}>{error}</p>
          </>
        ) : null}
        {phase === 'cancelled' ? <Muted c={c}>{t('errors.cancelled')}</Muted> : null}
        {phase === 'peerNotOpen' && device ? (
          <p style={{ color: c.danger, margin: 0 }}>
            {t('paired.notOpen', { name: device.name })}
          </p>
        ) : null}
      </Card>
      {busy ? (
        <GhostButton c={c} label={t('common.cancel')} danger onClick={cancel} />
      ) : phase === 'error' && serverErr ? (
        <>
          <PrimaryButton
            c={c}
            label={t('settings.server.change')}
            onClick={onServerSettings}
          />
          <GhostButton c={c} label={t('common.done')} onClick={onHome} />
        </>
      ) : (
        <PrimaryButton c={c} label={t('common.done')} onClick={onHome} />
      )}
    </>
  );
}

type ReceivePhase =
  | 'connecting'
  | 'confirm'
  | 'conflict'
  | 'transferring'
  | 'done'
  | 'declined'
  | 'error'
  | 'cancelled';

function Receive({
  c,
  code,
  device,
  onHome,
}: {
  c: Palette;
  code?: string;
  device?: PairedDevice;
  onHome: () => void;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<ReceivePhase>('connecting');
  const [offer, setOffer] = useState<ReceiveOffer | null>(null);
  const [direct, setDirect] = useState<boolean | null>(null);
  const [pct, setPct] = useState(0);
  const [savedName, setSavedName] = useState('');
  const [existingSize, setExistingSize] = useState(0);
  const [error, setError] = useState('');
  const idRef = useRef(0);
  const cancelledRef = useRef(false);
  // Where this transfer will be saved; read once - changing the setting
  // mid-receive should not affect a transfer already on screen.
  const downloadDirRef = useRef<string | null>(loadDownloadDir());

  useEffect(() => {
    const id = nextId++;
    idRef.current = id;
    handlers.set(id, (ev) => {
      if (ev.event === 'transit') {
        setDirect((ev.info ?? '').startsWith('Direct'));
      } else if (ev.event === 'progress') {
        setPct(ev.total ? Math.floor(((ev.done ?? 0) / ev.total) * 100) : 100);
      }
    });
    const gotOffer = (o: ReceiveOffer) => {
      setOffer(o);
      setPhase('confirm');
    };
    const failed = (e: unknown) => {
      if (cancelledRef.current) setPhase('cancelled');
      else {
        setError(friendlyError(t as any, e));
        setPhase('error');
      }
    };
    if (device) {
      (async () => {
        const deadline = Date.now() + PAIRED_RECEIVE_TIMEOUT_MS;
        while (Date.now() < deadline && !cancelledRef.current) {
          for (const bucket of candidateBuckets()) {
            if (cancelledRef.current) break;
            try {
              const derived = deriveCode(device.secret, bucket);
              gotOffer(
                await window.portalgems.requestReceive(id, derived, currentServer())
              );
              return;
            } catch {
              // unclaimed nameplate = sender not there yet; keep polling
            }
          }
        }
        failed(new Error(t('paired.nothingFound', { name: device.name })));
      })();
    } else if (code) {
      window.portalgems
        .requestReceive(id, code, currentServer())
        .then(gotOffer, failed);
    }
    return () => {
      handlers.delete(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startTransfer = (overwrite: boolean) => {
    setPhase('transferring');
    window.portalgems.acceptDownload(idRef.current, downloadDirRef.current, overwrite).then(
      (name) => {
        setSavedName(name);
        setPhase('done');
      },
      (e) => {
        if (cancelledRef.current) setPhase('cancelled');
        else {
          setError(friendlyError(t as any, e));
          setPhase('error');
        }
      }
    );
  };

  // The name this offer will occupy in the download folder: the folder name
  // for directory offers, the file name otherwise (both engine-sanitized).
  const targetName = offer ? offer.folder?.dirName ?? offer.fileName : '';

  // A same-named entry in the download folder gets a warning first; the
  // engine sanitizes the offered name, so it is exactly the name saved.
  const accept = async () => {
    if (!offer) return;
    const target = await window.portalgems
      .statTarget(downloadDirRef.current, targetName)
      .catch(() => ({ exists: false, size: 0, isFolder: false }));
    if (target.exists) {
      setExistingSize(target.size);
      setPhase('conflict');
      return;
    }
    startTransfer(false);
  };

  const decline = () => {
    window.portalgems.reject(idRef.current).catch(() => undefined);
    setPhase('declined');
  };

  const cancel = () => {
    cancelledRef.current = true;
    window.portalgems.cancel(idRef.current);
  };

  const busy = phase === 'connecting' || phase === 'transferring';

  return (
    <>
      <Title c={c} onBack={onHome}>{t('receive.title')}</Title>
      <Muted c={c}>{device ? device.name : code}</Muted>
      <Card c={c}>
        {phase === 'connecting' ? (
          <Muted c={c}>
            {device
              ? t('paired.receiveWaiting', { name: device.name })
              : t('receive.connecting')}
          </Muted>
        ) : null}
        {phase === 'confirm' && offer ? (
          <>
            <Subtitle c={c}>
              {offer.folder ? t('receive.incomingFolder') : t('receive.incoming')}
            </Subtitle>
            <p style={{ color: c.text, margin: 0 }}>
              {offer.folder
                ? t('folder.summary', {
                    name: offer.folder.dirName,
                    count: offer.folder.numFiles,
                    size: formatSize(offer.folder.numBytes),
                  })
                : `${offer.fileName} · ${formatSize(offer.fileSize)}`}
            </p>
            <Muted c={c}>
              {offer.folder
                ? t('receive.acceptQuestionFolder')
                : t('receive.acceptQuestion')}
            </Muted>
            <PrimaryButton c={c} label={t('common.accept')} onClick={accept} />
            <GhostButton c={c} label={t('common.decline')} danger onClick={decline} />
          </>
        ) : null}
        {phase === 'conflict' && offer ? (
          <>
            <Subtitle c={c}>
              {offer.folder ? t('receive.existsTitleFolder') : t('receive.existsTitle')}
            </Subtitle>
            <p style={{ color: c.text, margin: 0 }}>
              {t(offer.folder ? 'receive.existsBodyFolder' : 'receive.existsBody', {
                name: targetName,
                size: formatSize(existingSize),
              })}
            </p>
            <PrimaryButton
              c={c}
              label={t('receive.keepBoth')}
              onClick={() => startTransfer(false)}
            />
            <GhostButton
              c={c}
              label={t('receive.overwrite')}
              danger
              onClick={() => startTransfer(true)}
            />
            <GhostButton c={c} label={t('common.decline')} onClick={decline} />
          </>
        ) : null}
        {phase === 'transferring' ? (
          <>
            <Subtitle c={c}>
              {offer?.folder ? t('receive.receivingFolder') : t('receive.receiving')}
            </Subtitle>
            {direct !== null ? (
              <Muted c={c}>{direct ? t('transfer.direct') : t('transfer.relay')}</Muted>
            ) : null}
            <ProgressBar c={c} pct={pct} />
            <Muted c={c}>{t('transfer.progress', { pct })}</Muted>
          </>
        ) : null}
        {phase === 'done' ? (
          <>
            <Subtitle c={c}>
              {offer?.folder ? t('receive.successFolder') : t('receive.success')}
            </Subtitle>
            <p style={{ color: c.success, margin: 0 }}>
              {downloadDirRef.current
                ? t('receive.savedAsIn', {
                    name: savedName,
                    folder: downloadDirRef.current,
                  })
                : t('receive.savedAs', { name: savedName })}
            </p>
          </>
        ) : null}
        {phase === 'declined' ? <Muted c={c}>{t('receive.declined')}</Muted> : null}
        {phase === 'error' ? (
          <>
            <Subtitle c={c}>{t('errors.title')}</Subtitle>
            <p style={{ color: c.danger, margin: 0 }}>{error}</p>
          </>
        ) : null}
        {phase === 'cancelled' ? <Muted c={c}>{t('errors.cancelled')}</Muted> : null}
      </Card>
      {busy ? (
        <GhostButton c={c} label={t('common.cancel')} danger onClick={cancel} />
      ) : phase === 'confirm' || phase === 'conflict' ? null : (
        <PrimaryButton c={c} label={t('common.done')} onClick={onHome} />
      )}
    </>
  );
}

type PairPhase = 'menu' | 'showing' | 'working' | 'done' | 'error';

function Pair({ c, onHome }: { c: Palette; onHome: () => void }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<PairPhase>('menu');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [payloadText, setPayloadText] = useState('');
  const [manual, setManual] = useState('');
  const [peerName, setPeerName] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const cancelledRef = useRef(false);
  const idRef = useRef(0);

  const succeed = (name: string) => {
    setPeerName(name);
    setPhase('done');
  };
  const fail = (e: unknown) => {
    setError(friendlyError(t as any, e));
    setPhase('error');
  };

  const show = async () => {
    const myName = await window.portalgems.deviceName();
    const payload = createPairingPayload(myName);
    const encoded = encodePairingPayload(payload);
    setPayloadText(encoded);
    setQrDataUrl(await QRCodeLib.toDataURL(encoded, { margin: 1, width: 260 }));
    setPhase('showing');
    const id = nextId++;
    idRef.current = id;
    waitForPairingAsDisplayer(payload, id, () => cancelledRef.current).then(
      (device) => succeed(device.name),
      (e) => {
        if (!cancelledRef.current) fail(e);
      }
    );
  };

  const manualPair = async () => {
    const payload = parsePairingPayload(manual);
    if (!payload) {
      setError(t('pair.invalidPayload'));
      setPhase('error');
      return;
    }
    setPhase('working');
    const myName = await window.portalgems.deviceName();
    const id = nextId++;
    idRef.current = id;
    // Don't wait forever if the other side stopped listening.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      window.portalgems.cancel(id);
    }, 60_000);
    completePairingAsScanner(payload, myName, id)
      .then(
        (device) => succeed(device.name),
        (e) => {
          if (timedOut) fail(new Error(t('paired.notOpen', { name: payload.name })));
          else if (!cancelledRef.current) fail(e);
        }
      )
      .finally(() => clearTimeout(timer));
  };

  const copyPayload = () => {
    navigator.clipboard.writeText(payloadText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const cancelAndBack = () => {
    cancelledRef.current = true;
    window.portalgems.cancel(idRef.current);
    onHome();
  };

  return (
    <>
      <Title c={c} onBack={onHome}>{t('pair.title')}</Title>
      {phase === 'menu' ? (
        <Card c={c}>
          <PrimaryButton c={c} label={t('pair.showButton')} onClick={show} />
          <TextInput
            c={c}
            value={manual}
            onChange={setManual}
            placeholder={t('pair.manualPlaceholder')}
          />
          <GhostButton c={c} label={t('pair.manualButton')} onClick={manualPair} />
        </Card>
      ) : null}
      {phase === 'showing' ? (
        <Card c={c}>
          <Muted c={c}>{t('pair.showHint')}</Muted>
          <div style={{ textAlign: 'center' }}>
            <img
              src={qrDataUrl}
              alt="pairing QR"
              style={{ background: '#fff', borderRadius: 8, padding: 8 }}
            />
          </div>
          <PrimaryButton
            c={c}
            label={copied ? t('pair.copied') : t('pair.copyPayload')}
            onClick={copyPayload}
          />
          <Muted c={c}>{t('pair.waiting')}</Muted>
        </Card>
      ) : null}
      {phase === 'working' ? (
        <Card c={c}>
          <Muted c={c}>{t('pair.waiting')}</Muted>
        </Card>
      ) : null}
      {phase === 'done' ? (
        <Card c={c}>
          <Subtitle c={c}>{t('pair.success', { name: peerName })}</Subtitle>
        </Card>
      ) : null}
      {phase === 'error' ? (
        <Card c={c}>
          <Subtitle c={c}>{t('errors.title')}</Subtitle>
          <p style={{ color: c.danger, margin: 0 }}>{error}</p>
        </Card>
      ) : null}
      {phase === 'done' || phase === 'error' ? (
        <PrimaryButton c={c} label={t('common.done')} onClick={onHome} />
      ) : (
        <GhostButton c={c} label={t('common.cancel')} danger onClick={cancelAndBack} />
      )}
    </>
  );
}

const LANGUAGE_LABELS: Record<string, string> = {
  en: 'English',
  de: 'Deutsch',
  bs: 'Bosanski',
  ru: 'Русский',
  fr: 'Français',
  es: 'Español',
};

function Settings({
  c,
  themeName,
  onTheme,
  onHome,
  scrollToServer,
}: {
  c: Palette;
  themeName: ThemeName;
  onTheme: (name: ThemeName) => void;
  onHome: () => void;
  scrollToServer?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [server, setServer] = useState<ServerSettings>(() => loadServerSettings());
  const [downloadDir, setDownloadDir] = useState<string | null>(() => loadDownloadDir());

  const chooseDownloadDir = async () => {
    const dir = await window.portalgems.pickDirectory();
    if (!dir) return;
    saveDownloadDir(dir);
    setDownloadDir(dir);
  };
  const resetDownloadDir = () => {
    saveDownloadDir(null);
    setDownloadDir(null);
  };

  // Deep-link target: scroll to the server section when arriving from the
  // send-screen "Change server" shortcut.
  const serverRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollToServer) {
      serverRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [scrollToServer]);

  const updateServer = (next: ServerSettings) => {
    setServer(next);
    saveServerSettings(next);
  };
  const chooseServer = (choice: ServerChoice) =>
    updateServer({ ...server, choice });

  // First-visit helper: shown once until dismissed; reopenable via the info button.
  const [helpSeen, setHelpSeen] = useState(
    () => localStorage.getItem('pg-server-help-seen') === '1'
  );
  const [helpOpen, setHelpOpen] = useState(false);
  const dismissHelp = () => {
    setHelpSeen(true);
    setHelpOpen(false);
    localStorage.setItem('pg-server-help-seen', '1');
  };
  const showHelp = !helpSeen || helpOpen;

  const chooseLanguage = (lng: string) => {
    setLanguage(lng);
    localStorage.setItem('pg-language', lng);
  };

  const row = (selected: boolean): React.CSSProperties => ({
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    border: `1px solid ${selected ? c.primary : c.border}`,
    background: selected ? c.codeBg : 'transparent',
    borderRadius: 10,
    padding: `${spacing(2.5)}px ${spacing(3)}px`,
    cursor: 'pointer',
  });

  return (
    <>
      <Title c={c} onBack={onHome}>{t('settings.title')}</Title>
      <Card c={c}>
        <Subtitle c={c}>{t('settings.language')}</Subtitle>
        <Dropdown
          c={c}
          value={i18n.language}
          onChange={chooseLanguage}
          options={SUPPORTED_LANGUAGES.map((lng) => ({
            value: lng,
            label: LANGUAGE_LABELS[lng],
          }))}
        />
      </Card>
      <Card c={c}>
        <Subtitle c={c}>{t('settings.theme')}</Subtitle>
        {THEME_NAMES.map((name) => (
          <div key={name} style={row(themeName === name)} onClick={() => onTheme(name)}>
            <span style={{ display: 'flex', alignItems: 'center', gap: spacing(2.5) }}>
              <span
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 9,
                  background: themes[name].light.primary,
                }}
              />
              <span style={{ color: c.text }}>{t(`settings.themes.${name}`)}</span>
            </span>
            {themeName === name ? (
              <span style={{ color: c.primary, fontWeight: 700 }}>✓</span>
            ) : null}
          </div>
        ))}
      </Card>
      <Card c={c}>
        <Subtitle c={c}>{t('settings.downloads.title')}</Subtitle>
        <Muted c={c}>{t('settings.downloads.hint')}</Muted>
        <div style={{ ...row(false), cursor: 'default' }}>
          <span
            style={{
              color: c.text,
              fontFamily: downloadDir ? 'monospace' : undefined,
              fontSize: downloadDir ? fontSize.small : undefined,
              overflowWrap: 'anywhere',
            }}>
            {downloadDir ?? t('settings.downloads.defaultLabel')}
          </span>
        </div>
        <PrimaryButton
          c={c}
          label={t('settings.downloads.choose')}
          onClick={chooseDownloadDir}
        />
        {downloadDir ? (
          <GhostButton
            c={c}
            label={t('settings.downloads.reset')}
            onClick={resetDownloadDir}
          />
        ) : null}
      </Card>
      <div ref={serverRef}>
      <Card c={c}>
        <div
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Subtitle c={c}>{t('settings.server.title')}</Subtitle>
          <span
            onClick={() => setHelpOpen(true)}
            title={t('explain.choosingTitle')}
            style={{ color: c.primary, fontWeight: 700, cursor: 'pointer', fontSize: fontSize.subtitle }}>
            ⓘ
          </span>
        </div>
        <Muted c={c}>{t('settings.server.hint')}</Muted>
        {showHelp ? (
          <div
            style={{
              border: `1px solid ${c.primary}`,
              background: c.codeBg,
              borderRadius: 10,
              padding: spacing(3),
              marginTop: spacing(1),
            }}>
            <div style={{ color: c.text, fontWeight: 700, marginBottom: spacing(1.5) }}>
              {t('explain.choosingTitle')}
            </div>
            <div style={{ color: c.text, fontSize: fontSize.small, lineHeight: 1.5 }}>
              {t('explain.choosingBody')}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: spacing(2) }}>
              <span
                onClick={dismissHelp}
                style={{ color: c.primary, fontWeight: 700, cursor: 'pointer' }}>
                {t('common.gotIt')}
              </span>
            </div>
          </div>
        ) : null}
        {availableServerChoices().map((choice) => {
          const key =
            choice === 'public'
              ? 'choicePublic'
              : choice === 'portalgems'
                ? 'choicePortalgems'
                : 'choiceCustom';
          return (
            <div
              key={choice}
              style={row(server.choice === choice)}
              onClick={() => chooseServer(choice)}
            >
              <span style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ color: c.text }}>{t(`settings.server.${key}`)}</span>
                <span style={{ color: c.textMuted, fontSize: fontSize.small }}>
                  {t(`settings.server.${key}Hint`)}
                </span>
              </span>
              {server.choice === choice ? (
                <span style={{ color: c.primary, fontWeight: 700 }}>✓</span>
              ) : null}
            </div>
          );
        })}
        {server.choice === 'custom' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: spacing(2) }}>
            <Muted c={c}>{t('settings.server.leaveBlankHint')}</Muted>
            <span style={{ color: c.textMuted, fontSize: fontSize.small }}>
              {t('settings.server.rendezvousLabel')}
            </span>
            <TextInput
              c={c}
              value={server.customRendezvousUrl ?? ''}
              onChange={(v) => updateServer({ ...server, customRendezvousUrl: v })}
              placeholder="wss://relay.example/v1"
            />
            <span style={{ color: c.textMuted, fontSize: fontSize.small }}>
              {t('settings.server.transitLabel')}
            </span>
            <TextInput
              c={c}
              value={server.customTransitUrl ?? ''}
              onChange={(v) => updateServer({ ...server, customTransitUrl: v })}
              placeholder="tcp://transit.example:4001"
            />
            {!isCustomServerUsable(server) ? (
              <span style={{ color: c.danger, fontSize: fontSize.small }}>
                {t('settings.server.invalidUrl')}
              </span>
            ) : null}
          </div>
        ) : null}
      </Card>
      </div>
      <PrimaryButton c={c} label={t('common.done')} onClick={onHome} />
    </>
  );
}

const EXPLAIN_SECTIONS = ['codes', 'e2e', 'direct', 'servers', 'choosing', 'pairing', 'limits'] as const;

function Explain({ c, onHome }: { c: Palette; onHome: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      <Title c={c} onBack={onHome}>{t('explain.title')}</Title>
      <Muted c={c}>{t('explain.intro')}</Muted>
      {EXPLAIN_SECTIONS.map((key) => (
        <Card key={key} c={c}>
          <Subtitle c={c}>{t(`explain.${key}Title`)}</Subtitle>
          <Muted c={c}>{t(`explain.${key}Body`)}</Muted>
        </Card>
      ))}
      <PrimaryButton c={c} label={t('common.done')} onClick={onHome} />
    </>
  );
}
