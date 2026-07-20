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
  loadDownloadDir,
  saveFolderToDownloadDir,
  saveFolderToDownloads,
  saveToDownloadDir,
  saveToDownloads,
  statDownloadTarget,
  withTransferService,
  type PickedDirectory,
} from '../native';
import { currentServer } from '../server';
import { useTheme } from '../theme';

type Phase =
  | 'connecting'
  | 'confirm'
  | 'conflict'
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
  // Set when the sender offered a folder (protocol-v1 directory offer); the
  // engine unpacks it and `accept` returns a directory instead of a file.
  const [folderOffer, setFolderOffer] = useState<{
    dirName: string;
    numFiles: number;
    numBytes: number;
  } | null>(null);
  const [direct, setDirect] = useState<boolean | null>(null);
  const [pct, setPct] = useState(0);
  const [savedName, setSavedName] = useState('');
  const [existingSize, setExistingSize] = useState(0);
  const [usedFallback, setUsedFallback] = useState(false);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const incomingRef = useRef<IncomingFileInterface | null>(null);
  // Where this transfer will be saved; loaded once - changing the setting
  // mid-receive should not affect a transfer already on screen.
  const downloadDirRef = useRef<PickedDirectory | null>(null);
  useEffect(() => {
    loadDownloadDir().then((dir) => {
      downloadDirRef.current = dir;
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;

    const gotOffer = (incoming: IncomingFileInterface) => {
      incomingRef.current = incoming;
      setOfferName(incoming.fileName());
      setOfferSize(Number(incoming.fileSize()));
      const folder = incoming.folderOffer();
      setFolderOffer(
        folder
          ? {
              dirName: folder.dirName,
              numFiles: Number(folder.numFiles),
              numBytes: Number(folder.numBytes),
            }
          : null
      );
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

  const startTransfer = (overwrite: boolean) => {
    const incoming = incomingRef.current;
    if (!incoming) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('transferring');

    withTransferService(t('receive.title'), async () => {
      // The engine stages into the app cache, so the download folder - and a
      // file the user agreed to overwrite - is only touched after the file
      // has fully arrived; a failed transfer leaves it untouched.
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
      const savedName = savedPath.split('/').pop() ?? 'received.bin';
      const dir = downloadDirRef.current;
      if (folderOffer) {
        // `savedPath` is the unpacked folder staged in the app cache.
        if (dir) {
          const result = await saveFolderToDownloadDir(
            savedPath,
            dir.uri,
            savedName,
            overwrite
          );
          setUsedFallback(result.fallback);
          return result.name;
        }
        return saveFolderToDownloads(savedPath, savedName);
      }
      if (dir) {
        const result = await saveToDownloadDir(savedPath, dir.uri, savedName, overwrite);
        setUsedFallback(result.fallback);
        return result.name;
      }
      return saveToDownloads(savedPath, savedName);
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

  // The name this offer will occupy in the download location: the folder
  // name for directory offers, the file name otherwise.
  const targetName = folderOffer ? folderOffer.dirName : offerName;

  // With a custom folder we can see other apps' files, so warn about a
  // same-name collision before accepting. (Default MediaStore Downloads keeps
  // the system's automatic renaming - other apps' files are not visible.)
  const accept = async () => {
    const dir = downloadDirRef.current;
    if (dir && targetName) {
      const target = await statDownloadTarget(dir.uri, targetName).catch(() => null);
      if (target?.exists) {
        setExistingSize(target.size);
        setPhase('conflict');
        return;
      }
    }
    startTransfer(false);
  };

  const decline = () => {
    incomingRef.current?.reject().catch(() => undefined);
    setPhase('declined');
  };

  const busy =
    phase === 'connecting' || phase === 'transferring' || phase === 'saving';

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      <Title onBack={onHome}>{t('receive.title')}</Title>
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
            <Subtitle>
              {folderOffer ? t('receive.incomingFolder') : t('receive.incoming')}
            </Subtitle>
            <Text style={{ color: c.text, fontSize: fontSize.subtitle }}>
              {folderOffer
                ? t('folder.summary', {
                    name: folderOffer.dirName,
                    count: folderOffer.numFiles,
                    size: formatSize(folderOffer.numBytes),
                  })
                : `${offerName} · ${formatSize(offerSize)}`}
            </Text>
            <Muted>
              {folderOffer
                ? t('receive.acceptQuestionFolder')
                : t('receive.acceptQuestion')}
            </Muted>
            <PrimaryButton label={t('common.accept')} onPress={accept} />
            <GhostButton label={t('common.decline')} danger onPress={decline} />
          </>
        ) : null}

        {phase === 'conflict' ? (
          <>
            <Subtitle>
              {folderOffer ? t('receive.existsTitleFolder') : t('receive.existsTitle')}
            </Subtitle>
            <Text style={{ color: c.text, fontSize: fontSize.body }}>
              {t(folderOffer ? 'receive.existsBodyFolder' : 'receive.existsBody', {
                name: targetName,
                size: formatSize(existingSize),
              })}
            </Text>
            <PrimaryButton
              label={t('receive.keepBoth')}
              onPress={() => startTransfer(false)}
            />
            <GhostButton
              label={t('receive.overwrite')}
              danger
              onPress={() => startTransfer(true)}
            />
            <GhostButton label={t('common.decline')} onPress={decline} />
          </>
        ) : null}

        {phase === 'transferring' || phase === 'saving' ? (
          <>
            <Subtitle>
              {folderOffer ? t('receive.receivingFolder') : t('receive.receiving')}
            </Subtitle>
            {direct !== null ? (
              <Muted>{direct ? t('transfer.direct') : t('transfer.relay')}</Muted>
            ) : null}
            <ProgressBar pct={pct} />
            <Muted>{t('transfer.progress', { pct })}</Muted>
          </>
        ) : null}

        {phase === 'done' ? (
          <>
            <Subtitle>
              {folderOffer ? t('receive.successFolder') : t('receive.success')}
            </Subtitle>
            <Text style={{ color: c.success, fontSize: fontSize.body }}>
              {downloadDirRef.current && !usedFallback
                ? t('receive.savedAsIn', {
                    name: savedName,
                    folder: downloadDirRef.current.label,
                  })
                : t('receive.savedAs', { name: savedName })}
            </Text>
            {usedFallback ? <Muted>{t('receive.folderFallback')}</Muted> : null}
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
      ) : phase === 'confirm' || phase === 'conflict' ? null : (
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
