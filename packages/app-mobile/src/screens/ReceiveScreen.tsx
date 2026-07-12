import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { requestReceive, type IncomingFileInterface } from 'wormhole-rn';
import {
  candidateBuckets,
  deriveCode,
  fontSize,
  spacing,
  PAIRED_RECEIVE_TIMEOUT_MS,
  type PairedDevice,
} from '@portalgems/core';
import {
  Card,
  GhostButton,
  Muted,
  PrimaryButton,
  ProgressBar,
  Subtitle,
  Title,
} from '../components';
import { friendlyError } from '../errors';
import {
  formatSize,
  incomingDir,
  saveToDownloads,
  withTransferService,
} from '../native';
import { currentServer } from '../server';
import { useTheme } from '../theme';

type Phase =
  | 'connecting'
  | 'confirm'
  | 'transferring'
  | 'saving'
  | 'done'
  | 'declined'
  | 'error'
  | 'cancelled';

export default function ReceiveScreen({
  code,
  device,
  onHome,
}: {
  code?: string;
  device?: PairedDevice;
  onHome: () => void;
}) {
  const { t } = useTranslation();
  const c = useTheme();
  const [phase, setPhase] = useState<Phase>('connecting');
  const [offerName, setOfferName] = useState('');
  const [offerSize, setOfferSize] = useState(0);
  const [direct, setDirect] = useState<boolean | null>(null);
  const [pct, setPct] = useState(0);
  const [savedName, setSavedName] = useState('');
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const incomingRef = useRef<IncomingFileInterface | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;

    const gotOffer = (incoming: IncomingFileInterface) => {
      incomingRef.current = incoming;
      setOfferName(incoming.fileName());
      setOfferSize(Number(incoming.fileSize()));
      setPhase('confirm');
    };
    const failed = (e: unknown) => {
      if (controller.signal.aborted) setPhase('cancelled');
      else {
        setError(friendlyError(t, e));
        setPhase('error');
      }
    };

    if (device) {
      // Paired receive: poll the derived candidate codes until the sender
      // shows up or we give up. An unclaimed nameplate just means "not yet".
      (async () => {
        const server = await currentServer();
        const deadline = Date.now() + PAIRED_RECEIVE_TIMEOUT_MS;
        let lastError: unknown = new Error(t('paired.nothingFound', { name: device.name }));
        while (Date.now() < deadline && !controller.signal.aborted) {
          for (const bucket of candidateBuckets()) {
            if (controller.signal.aborted) break;
            try {
              const derived = deriveCode(device.secret, bucket);
              const incoming = await requestReceive(derived, server, {
                signal: controller.signal,
              });
              gotOffer(incoming);
              return;
            } catch (e) {
              lastError = e;
            }
          }
        }
        if (!controller.signal.aborted) {
          failed(new Error(t('paired.nothingFound', { name: device.name })));
        } else {
          failed(lastError);
        }
      })();
    } else if (code) {
      void (async () => {
        const server = await currentServer();
        requestReceive(code, server, { signal: controller.signal }).then(
          gotOffer,
          failed
        );
      })();
    }

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const accept = () => {
    const incoming = incomingRef.current;
    if (!incoming) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('transferring');

    withTransferService(t('receive.title'), async () => {
      const savedPath = await incoming.accept(
        incomingDir,
        {
          onCode: () => {},
          onTransit: (info) => setDirect(info.startsWith('Direct')),
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
        if (controller.signal.aborted) setPhase('cancelled');
        else {
          setError(friendlyError(t, e));
          setPhase('error');
        }
      }
    );
  };

  const decline = () => {
    incomingRef.current?.reject().catch(() => undefined);
    setPhase('declined');
  };

  const busy =
    phase === 'connecting' || phase === 'transferring' || phase === 'saving';

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      <Title>{t('receive.title')}</Title>
      <Muted>{device ? device.name : code}</Muted>

      <Card>
        {phase === 'connecting' ? (
          <Muted>
            {device
              ? t('paired.receiveWaiting', { name: device.name })
              : t('receive.connecting')}
          </Muted>
        ) : null}

        {phase === 'confirm' ? (
          <>
            <Subtitle>{t('receive.incoming')}</Subtitle>
            <Text style={{ color: c.text, fontSize: fontSize.subtitle }}>
              {offerName} · {formatSize(offerSize)}
            </Text>
            <Muted>{t('receive.acceptQuestion')}</Muted>
            <PrimaryButton label={t('common.accept')} onPress={accept} />
            <GhostButton label={t('common.decline')} danger onPress={decline} />
          </>
        ) : null}

        {phase === 'transferring' || phase === 'saving' ? (
          <>
            <Subtitle>{t('receive.receiving')}</Subtitle>
            {direct !== null ? (
              <Muted>{direct ? t('transfer.direct') : t('transfer.relay')}</Muted>
            ) : null}
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

        {phase === 'declined' ? <Muted>{t('receive.declined')}</Muted> : null}

        {phase === 'error' ? (
          <>
            <Subtitle>{t('errors.title')}</Subtitle>
            <Text style={{ color: c.danger, fontSize: fontSize.body }}>
              {error}
            </Text>
          </>
        ) : null}

        {phase === 'cancelled' ? <Muted>{t('errors.cancelled')}</Muted> : null}
      </Card>

      {busy ? (
        <GhostButton
          label={t('common.cancel')}
          danger
          onPress={() => abortRef.current?.abort()}
        />
      ) : phase === 'confirm' ? null : (
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
