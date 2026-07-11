import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import QRCodeLib from 'qrcode';
import {
  createPairingPayload,
  currentBucket,
  candidateBuckets,
  deriveCode,
  encodePairingPayload,
  friendlyError,
  parsePairingPayload,
  spacing,
  PAIRED_RECEIVE_TIMEOUT_MS,
  PAIRED_SEND_TIMEOUT_MS,
  type PairedDevice,
  type Palette,
} from '@portalgems/core';
import {
  completePairingAsScanner,
  loadDevices,
  removeDevice,
  waitForPairingAsDisplayer,
} from './pairing';
import {
  Card,
  CodeBox,
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
      pickFile(): Promise<{ path: string; name: string; size: number } | null>;
      send(id: number, path: string, code?: string): Promise<void>;
      requestReceive(
        id: number,
        code: string
      ): Promise<{ fileName: string; fileSize: number }>;
      accept(id: number, destDir?: string): Promise<string>;
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

const CODE_RE = /^\d+(-[a-zA-Z0-9]+)+$/;
let nextId = 1;

// Per-transfer event fan-out: screens register a handler for their id.
const handlers = new Map<number, (ev: PgEvent) => void>();
window.portalgems.onEvent((ev) => handlers.get(ev.id)?.(ev));

type Route =
  | { name: 'home' }
  | {
      name: 'send';
      file: { path: string; name: string; size: number };
      device?: PairedDevice;
    }
  | { name: 'receive'; code?: string; device?: PairedDevice }
  | { name: 'pair' };

export default function App() {
  const c = usePalette();
  const [route, setRoute] = useState<Route>({ name: 'home' });
  const goHome = () => setRoute({ name: 'home' });

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
          onSend={(file, device) => setRoute({ name: 'send', file, device })}
          onReceive={(code) => setRoute({ name: 'receive', code })}
          onReceiveFrom={(device) => setRoute({ name: 'receive', device })}
          onPair={() => setRoute({ name: 'pair' })}
        />
      ) : route.name === 'send' ? (
        <Send c={c} file={route.file} device={route.device} onHome={goHome} />
      ) : route.name === 'receive' ? (
        <Receive c={c} code={route.code} device={route.device} onHome={goHome} />
      ) : (
        <Pair c={c} onHome={goHome} />
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
}: {
  c: Palette;
  onSend: (
    file: { path: string; name: string; size: number },
    device?: PairedDevice
  ) => void;
  onReceive: (code: string) => void;
  onReceiveFrom: (device: PairedDevice) => void;
  onPair: () => void;
}) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [devices, setDevices] = useState<PairedDevice[]>([]);

  useEffect(() => {
    loadDevices().then(setDevices);
  }, []);

  const pick = async (device?: PairedDevice) => {
    const file = await window.portalgems.pickFile();
    if (file) onSend(file, device);
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
  file,
  device,
  onHome,
}: {
  c: Palette;
  file: { path: string; name: string; size: number };
  device?: PairedDevice;
  onHome: () => void;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<SendPhase>('starting');
  const [code, setCode] = useState('');
  const [direct, setDirect] = useState<boolean | null>(null);
  const [pct, setPct] = useState(0);
  const [error, setError] = useState('');
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
    window.portalgems.send(id, file.path, pairedCode).then(
      () => setPhase('done'),
      (e) => {
        if (timedOut) setPhase('peerNotOpen');
        else if (cancelledRef.current) setPhase('cancelled');
        else {
          setError(friendlyError(t as any, e));
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

  return (
    <>
      <Title c={c}>{t('send.title')}</Title>
      <Muted c={c}>
        {file.name} · {formatSize(file.size)}
      </Muted>
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
            <Subtitle c={c}>{t('send.sending', { name: file.name })}</Subtitle>
            <Muted c={c}>{direct ? t('transfer.direct') : t('transfer.relay')}</Muted>
            <ProgressBar c={c} pct={pct} />
            <Muted c={c}>{t('transfer.progress', { pct })}</Muted>
          </>
        ) : null}
        {phase === 'done' ? (
          <>
            <Subtitle c={c}>{t('send.success')}</Subtitle>
            <p style={{ color: c.success, margin: 0 }}>
              {t('send.successDetail', { name: file.name, size: formatSize(file.size) })}
            </p>
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
      ) : (
        <PrimaryButton c={c} label={t('common.done')} onClick={onHome} />
      )}
    </>
  );
}

type ReceivePhase =
  | 'connecting'
  | 'confirm'
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
  const [offer, setOffer] = useState<{ fileName: string; fileSize: number } | null>(null);
  const [direct, setDirect] = useState<boolean | null>(null);
  const [pct, setPct] = useState(0);
  const [savedName, setSavedName] = useState('');
  const [error, setError] = useState('');
  const idRef = useRef(0);
  const cancelledRef = useRef(false);

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
    const gotOffer = (o: { fileName: string; fileSize: number }) => {
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
              gotOffer(await window.portalgems.requestReceive(id, derived));
              return;
            } catch {
              // unclaimed nameplate = sender not there yet; keep polling
            }
          }
        }
        failed(new Error(t('paired.nothingFound', { name: device.name })));
      })();
    } else if (code) {
      window.portalgems.requestReceive(id, code).then(gotOffer, failed);
    }
    return () => {
      handlers.delete(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const accept = () => {
    setPhase('transferring');
    window.portalgems.accept(idRef.current).then(
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
      <Title c={c}>{t('receive.title')}</Title>
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
            <Subtitle c={c}>{t('receive.incoming')}</Subtitle>
            <p style={{ color: c.text, margin: 0 }}>
              {offer.fileName} · {formatSize(offer.fileSize)}
            </p>
            <Muted c={c}>{t('receive.acceptQuestion')}</Muted>
            <PrimaryButton c={c} label={t('common.accept')} onClick={accept} />
            <GhostButton c={c} label={t('common.decline')} danger onClick={decline} />
          </>
        ) : null}
        {phase === 'transferring' ? (
          <>
            <Subtitle c={c}>{t('receive.receiving')}</Subtitle>
            {direct !== null ? (
              <Muted c={c}>{direct ? t('transfer.direct') : t('transfer.relay')}</Muted>
            ) : null}
            <ProgressBar c={c} pct={pct} />
            <Muted c={c}>{t('transfer.progress', { pct })}</Muted>
          </>
        ) : null}
        {phase === 'done' ? (
          <>
            <Subtitle c={c}>{t('receive.success')}</Subtitle>
            <p style={{ color: c.success, margin: 0 }}>
              {t('receive.savedAs', { name: savedName })}
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
      ) : phase === 'confirm' ? null : (
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
      <Title c={c}>{t('pair.title')}</Title>
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
