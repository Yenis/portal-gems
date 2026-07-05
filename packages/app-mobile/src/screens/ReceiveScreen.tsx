import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { receiveFile } from 'wormhole-rn';
import { fontSize, spacing } from '@portalgems/core';
import {
  Card,
  GhostButton,
  Muted,
  PrimaryButton,
  ProgressBar,
  Subtitle,
  Title,
} from '../components';
import { incomingDir, saveToDownloads, withTransferService } from '../native';
import { useTheme } from '../theme';

type Phase = 'connecting' | 'transferring' | 'saving' | 'done' | 'error' | 'cancelled';

export default function ReceiveScreen({
  code,
  onHome,
}: {
  code: string;
  onHome: () => void;
}) {
  const { t } = useTranslation();
  const c = useTheme();
  const [phase, setPhase] = useState<Phase>('connecting');
  const [direct, setDirect] = useState<boolean | null>(null);
  const [pct, setPct] = useState(0);
  const [savedName, setSavedName] = useState('');
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    let cancelled = false;

    withTransferService(t('receive.title'), async () => {
      const savedPath = await receiveFile(
        code,
        incomingDir,
        {
          onCode: () => {},
          onTransit: (info) => {
            setDirect(info.startsWith('Direct'));
            setPhase('transferring');
          },
          onProgress: (done, total) => {
            setPct(total === 0n ? 100 : Number((done * 100n) / total));
          },
        },
        { signal: controller.signal }
      );
      setPhase('saving');
      const fileName = savedPath.split('/').pop() ?? 'received.bin';
      return saveToDownloads(savedPath, fileName);
    }).then(
      (finalName) => {
        setSavedName(finalName);
        setPhase('done');
      },
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

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      <Title>{t('receive.title')}</Title>
      <Muted>{code}</Muted>

      <Card>
        {phase === 'connecting' ? <Muted>{t('receive.connecting')}</Muted> : null}

        {phase === 'transferring' || phase === 'saving' ? (
          <>
            <Subtitle>{t('receive.receiving')}</Subtitle>
            <Muted>{direct ? t('transfer.direct') : t('transfer.relay')}</Muted>
            <ProgressBar pct={pct} />
            <Muted>{t('transfer.progress', { pct })}</Muted>
          </>
        ) : null}

        {phase === 'done' ? (
          <>
            <Subtitle>{t('receive.success')}</Subtitle>
            <Text style={{ color: c.success, fontSize: fontSize.body }}>
              {t('receive.savedAs', { name: savedName })}
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

      {phase === 'connecting' || phase === 'transferring' || phase === 'saving' ? (
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
