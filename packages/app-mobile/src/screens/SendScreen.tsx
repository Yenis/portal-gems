import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Clipboard from '@react-native-clipboard/clipboard';
import { sendFile, sendZipAsFolder } from 'wormhole-rn';
import {
  currentBucket,
  deriveCode,
  fontSize,
  spacing,
  PAIRED_SEND_TIMEOUT_MS,
  type PairedDevice,
} from '@portalgems/core';
import {
  Card,
  CodeBox,
  GhostButton,
  Muted,
  PrimaryButton,
  ProgressBar,
  Subtitle,
  Title,
} from '../components';
import { friendlyError, isServerUnreachableError } from '../errors';
import {
  deleteFile,
  formatSize,
  withTransferService,
  zipTreeToCache,
  type SendItem,
  type ZippedFolder,
} from '../native';
import { currentServer } from '../server';
import { useTheme } from '../theme';

type Phase =
  | 'starting'
  | 'preparing'
  | 'waiting'
  | 'transferring'
  | 'done'
  | 'error'
  | 'cancelled'
  | 'peerNotOpen';

export default function SendScreen({
  item,
  device,
  onHome,
  onServerSettings,
}: {
  item: SendItem;
  device?: PairedDevice;
  onHome: () => void;
  onServerSettings: () => void;
}) {
  const { t } = useTranslation();
  const c = useTheme();
  const [phase, setPhase] = useState<Phase>('starting');
  const [code, setCode] = useState('');
  const [direct, setDirect] = useState<boolean | null>(null);
  const [pct, setPct] = useState(0);
  const [folderStats, setFolderStats] = useState<ZippedFolder | null>(null);
  const [error, setError] = useState('');
  const [serverErr, setServerErr] = useState(false);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    let cancelled = false;
    let timedOut = false;
    let connected = false;

    // Paired sends: the code is derived, never typed. If the peer doesn't
    // pick up within the timeout, give up with a "device not open" message.
    // The timer is armed when the wormhole work starts - for folders that is
    // AFTER zipping, so a slow zip cannot eat into the peer's window.
    const pairedCode = device
      ? deriveCode(device.secret, currentBucket())
      : undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const armPairedTimeout = () => {
      if (!device) return;
      timer = setTimeout(() => {
        if (!connected) {
          timedOut = true;
          controller.abort();
        }
      }, PAIRED_SEND_TIMEOUT_MS);
    };

    const listener = {
      onCode: (value: string) => {
        setCode(value);
        setPhase('waiting');
      },
      onTransit: (info: string) => {
        connected = true;
        setDirect(info.startsWith('Direct'));
        setPhase('transferring');
      },
      onProgress: (done: bigint, total: bigint) => {
        setPct(total === 0n ? 100 : Number((done * 100n) / total));
      },
    };

    void (async () => {
    const server = await currentServer();
    const work = async () => {
      if (item.kind === 'folder') {
        // The SAF tree is zipped into the cache first (Rust cannot read
        // content:// URIs); the engine then sends the zip under a
        // protocol-v1 directory offer with the stats counted while zipping.
        setPhase('preparing');
        const zipped = await zipTreeToCache(item.uri);
        setFolderStats(zipped);
        if (controller.signal.aborted) {
          await deleteFile(zipped.path).catch(() => undefined);
          throw new Error('cancelled');
        }
        armPairedTimeout();
        try {
          await sendZipAsFolder(
            zipped.path,
            zipped.name,
            BigInt(zipped.fileCount),
            BigInt(zipped.totalBytes),
            pairedCode,
            server,
            listener,
            { signal: controller.signal }
          );
        } finally {
          await deleteFile(zipped.path).catch(() => undefined);
        }
      } else {
        armPairedTimeout();
        await sendFile(item.path, pairedCode, server, listener, {
          signal: controller.signal,
        });
      }
    };
    withTransferService(t('send.title'), work).then(
      () => setPhase('done'),
      (e) => {
        if (timedOut) {
          setPhase('peerNotOpen');
        } else if (cancelled || controller.signal.aborted) {
          setPhase('cancelled');
        } else {
          setError(friendlyError(t, e));
          setServerErr(isServerUnreachableError(e));
          setPhase('error');
        }
      }
    ).finally(() => {
      if (timer) clearTimeout(timer);
    });
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copy = () => {
    Clipboard.setString(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const summary =
    item.kind === 'folder'
      ? folderStats
        ? t('folder.summary', {
            name: item.name,
            count: folderStats.fileCount,
            size: formatSize(folderStats.totalBytes),
          })
        : item.name
      : `${item.name} · ${formatSize(item.size)}`;

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      <Title onBack={onHome}>{t('send.title')}</Title>
      <Muted>{summary}</Muted>

      <Card>
        {phase === 'starting' ? <Muted>{t('receive.connecting')}</Muted> : null}
        {phase === 'preparing' ? <Muted>{t('send.preparingFolder')}</Muted> : null}

        {phase === 'waiting' ? (
          device ? (
            <Muted>{t('paired.sendWaiting', { name: device.name })}</Muted>
          ) : (
            <>
              <Subtitle>{t('send.waitingForReceiver')}</Subtitle>
              <CodeBox code={code} />
              <PrimaryButton
                label={copied ? t('send.codeCopied') : t('send.copyCode')}
                onPress={copy}
              />
            </>
          )
        ) : null}

        {phase === 'transferring' ? (
          <>
            <Subtitle>
              {item.kind === 'folder'
                ? t('send.sendingFolder', { name: item.name })
                : t('send.sending', { name: item.name })}
            </Subtitle>
            <Muted>{direct ? t('transfer.direct') : t('transfer.relay')}</Muted>
            <ProgressBar pct={pct} />
            <Muted>{t('transfer.progress', { pct })}</Muted>
          </>
        ) : null}

        {phase === 'done' ? (
          <>
            <Subtitle>
              {item.kind === 'folder' ? t('send.successFolder') : t('send.success')}
            </Subtitle>
            <Text style={{ color: c.success, fontSize: fontSize.body }}>
              {summary}
            </Text>
          </>
        ) : null}

        {phase === 'error' ? (
          <>
            <Subtitle>{t('errors.title')}</Subtitle>
            <Text style={{ color: c.danger, fontSize: fontSize.body }}>
              {error}
            </Text>
          </>
        ) : null}

        {phase === 'cancelled' ? <Muted>{t('errors.cancelled')}</Muted> : null}

        {phase === 'peerNotOpen' && device ? (
          <Text style={{ color: c.danger, fontSize: fontSize.body }}>
            {t('paired.notOpen', { name: device.name })}
          </Text>
        ) : null}
      </Card>

      {phase === 'waiting' ||
      phase === 'transferring' ||
      phase === 'starting' ||
      phase === 'preparing' ? (
        <GhostButton
          label={t('common.cancel')}
          danger
          onPress={() => abortRef.current?.abort()}
        />
      ) : phase === 'error' && serverErr ? (
        <>
          <PrimaryButton
            label={t('settings.server.change')}
            onPress={onServerSettings}
          />
          <GhostButton label={t('common.done')} onPress={onHome} />
        </>
      ) : (
        <PrimaryButton label={t('common.done')} onPress={onHome} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: spacing(5),
    paddingTop: spacing(14),
    gap: spacing(5),
  },
});
