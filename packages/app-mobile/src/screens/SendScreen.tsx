import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Clipboard from '@react-native-clipboard/clipboard';
import { sendFile } from 'wormhole-rn';
import { fontSize, spacing } from '@portalgems/core';
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
import { formatSize, withTransferService, type PickedFile } from '../native';
import { useTheme } from '../theme';

type Phase = 'starting' | 'waiting' | 'transferring' | 'done' | 'error' | 'cancelled';

export default function SendScreen({
  file,
  onHome,
}: {
  file: PickedFile;
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

    withTransferService(t('send.title'), () =>
      sendFile(
        file.path,
        undefined,
        {
          onCode: (value) => {
            setCode(value);
            setPhase('waiting');
          },
          onTransit: (info) => {
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
        if (cancelled || controller.signal.aborted) {
          setPhase('cancelled');
        } else {
          setError(String(e?.message ?? e));
          setPhase('error');
        }
      }
    );

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
          <>
            <Subtitle>{t('send.waitingForReceiver')}</Subtitle>
            <CodeBox code={code} />
            <PrimaryButton
              label={copied ? t('send.codeCopied') : t('send.copyCode')}
              onPress={copy}
            />
          </>
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
              {t('errors.transferFailed', { message: error })}
            </Text>
          </>
        ) : null}

        {phase === 'cancelled' ? <Muted>{t('errors.cancelled')}</Muted> : null}
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
