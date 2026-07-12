import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Clipboard from '@react-native-clipboard/clipboard';
import { sendFile } from 'wormhole-rn';
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
import { friendlyError } from '../errors';
import { formatSize, withTransferService, type PickedFile } from '../native';
import { currentServer } from '../server';
import { useTheme } from '../theme';

type Phase =
  | 'starting'
  | 'waiting'
  | 'transferring'
  | 'done'
  | 'error'
  | 'cancelled'
  | 'peerNotOpen';

export default function SendScreen({
  file,
  device,
  onHome,
}: {
  file: PickedFile;
  device?: PairedDevice;
  onHome: () => void;
}) {
  const { t } = useTranslation();
  const c = useTheme();
  const [phase, setPhase] = useState<Phase>('starting');
  const [code, setCode] = useState('');
  const [direct, setDirect] = useState<boolean | null>(null);
  const [pct, setPct] = useState(0);
  const [error, setError] = useState('');
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
    const pairedCode = device
      ? deriveCode(device.secret, currentBucket())
      : undefined;
    const timer = device
      ? setTimeout(() => {
          if (!connected) {
            timedOut = true;
            controller.abort();
          }
        }, PAIRED_SEND_TIMEOUT_MS)
      : null;

    void (async () => {
    const server = await currentServer();
    withTransferService(t('send.title'), () =>
      sendFile(
        file.path,
        pairedCode,
        server,
        {
          onCode: (value) => {
            setCode(value);
            setPhase('waiting');
          },
          onTransit: (info) => {
            connected = true;
            setDirect(info.startsWith('Direct'));
            setPhase('transferring');
          },
          onProgress: (done, total) => {
            setPct(total === 0n ? 100 : Number((done * 100n) / total));
          },
        },
        { signal: controller.signal }
      )
    ).then(
      () => setPhase('done'),
      (e) => {
        if (timedOut) {
          setPhase('peerNotOpen');
        } else if (cancelled || controller.signal.aborted) {
          setPhase('cancelled');
        } else {
          setError(friendlyError(t, e));
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

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      <Title>{t('send.title')}</Title>
      <Muted>
        {file.name} · {formatSize(file.size)}
      </Muted>

      <Card>
        {phase === 'starting' ? <Muted>{t('receive.connecting')}</Muted> : null}

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
            <Subtitle>{t('send.sending', { name: file.name })}</Subtitle>
            <Muted>{direct ? t('transfer.direct') : t('transfer.relay')}</Muted>
            <ProgressBar pct={pct} />
            <Muted>{t('transfer.progress', { pct })}</Muted>
          </>
        ) : null}

        {phase === 'done' ? (
          <>
            <Subtitle>{t('send.success')}</Subtitle>
            <Text style={{ color: c.success, fontSize: fontSize.body }}>
              {t('send.successDetail', {
                name: file.name,
                size: formatSize(file.size),
              })}
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

      {phase === 'waiting' || phase === 'transferring' || phase === 'starting' ? (
        <GhostButton
          label={t('common.cancel')}
          danger
          onPress={() => abortRef.current?.abort()}
        />
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
