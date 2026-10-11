import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Clipboard from '@react-native-clipboard/clipboard';
import { requestReceive, type IncomingFileInterface } from 'wormhole-rn';
import {
  bundleText,
  deviceLabel,
  candidateCodes,
  fontSize,
  landEntries,
  savedBundleText,
  spacing,
  PAIRED_RECEIVE_TIMEOUT_MS,
  type BundleCounts,
  type PairedDevice,
} from '@portalgems/core';
import {
  Card,
  GhostButton,
  MessageBox,
  Muted,
  PrimaryButton,
  ProgressBar,
  Subtitle,
  Title,
  TransferRoute,
} from '../components';
import { friendlyError } from '../errors';
import {
  formatSize,
  incomingDir,
  listStaged,
  loadDownloadDir,
  removeStaged,
  saveFolderToDownloadDir,
  saveFolderToDownloads,
  saveToDownloadDir,
  saveToDownloads,
  statDownloadTarget,
  withTransferService,
  type PickedDirectory,
} from '../native';
import { markDeviceUsed, withAttemptBound } from '../pairing';
import { currentServer } from '../server';
import { useTheme } from '../theme';

type Phase =
  | 'connecting'
  | 'confirm'
  | 'message'
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
    // A selection of loose items rather than one folder: its contents land
    // in the download location themselves, and `dirName` is not shown.
    loose: BundleCounts | null;
  } | null>(null);
  // For a loose bundle: what reached the download location, counted there.
  const [landed, setLanded] = useState<{ saved: BundleCounts; expected: number } | null>(null);
  const [direct, setDirect] = useState<boolean | null>(null);
  const [pct, setPct] = useState(0);
  const [savedName, setSavedName] = useState('');
  const [existingSize, setExistingSize] = useState(0);
  // Set when the sender offered text instead of a file.
  const [message, setMessage] = useState<string | null>(null);
  const [copiedText, setCopiedText] = useState(false);
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
      // Text arrives complete - the engine acknowledged it - so there is
      // nothing to accept and no reason to ask.
      const text = incoming.text();
      if (text !== undefined) {
        setMessage(text);
        if (device) markDeviceUsed(device.id).catch(() => undefined);
        setPhase('message');
        return;
      }
      setOfferName(incoming.fileName());
      setOfferSize(Number(incoming.fileSize()));
      const folder = incoming.folderOffer();
      setFolderOffer(
        folder
          ? {
              dirName: folder.dirName,
              numFiles: Number(folder.numFiles),
              numBytes: Number(folder.numBytes),
              loose: folder.loose
                ? {
                    files: Number(folder.loose.files),
                    folders: Number(folder.loose.folders),
                  }
                : null,
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
      // shows up or we give up. An unclaimed nameplate just means "not yet";
      // each attempt is bounded, because a nameplate held by a sender that
      // died while waiting would otherwise stall the loop indefinitely. The
      // candidates cover the neighbouring buckets for clock skew, and the
      // later codes inside each one, which is where a sender goes after a
      // send that did not finish.
      (async () => {
        const server = await currentServer();
        const deadline = Date.now() + PAIRED_RECEIVE_TIMEOUT_MS;
        let lastError: unknown = new Error(t('paired.nothingFound', { name: deviceLabel(device) }));
        while (Date.now() < deadline && !controller.signal.aborted) {
          for (const derived of candidateCodes(device.secret)) {
            if (controller.signal.aborted) break;
            try {
              const incoming = await withAttemptBound(controller.signal, (attempt) =>
                requestReceive(derived, server, { signal: attempt })
              );
              gotOffer(incoming);
              return;
            } catch (e) {
              lastError = e;
            }
          }
        }
        if (!controller.signal.aborted) {
          failed(new Error(t('paired.nothingFound', { name: deviceLabel(device) })));
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
      // Save under the name the offer asked for, not the staged file's name.
      // Anything already sitting in the staging directory - a partial file
      // from a transfer the OS killed - makes the engine stage this one as
      // `name (1).ext`, and that suffix has no business reaching Downloads.
      const savedName =
        (folderOffer ? folderOffer.dirName : offerName) ||
        savedPath.split('/').pop() ||
        'received.bin';
      const dir = downloadDirRef.current;
      if (folderOffer?.loose) {
        // A bundle: `savedPath` is its unpacked contents, and each top-level
        // item is saved under its own name with the calls a single file and
        // a single folder use. Never with overwrite - nothing was asked, so
        // a taken name is kept beside. One item failing does not stop the
        // rest; what is reported is what was actually saved.
        let fallback = false;
        const landing = await landEntries(await listStaged(savedPath), async (item) => {
          if (!dir) {
            if (item.isFolder) await saveFolderToDownloads(item.path, item.name);
            else await saveToDownloads(item.path, item.name);
            return;
          }
          const result = item.isFolder
            ? await saveFolderToDownloadDir(item.path, dir.uri, item.name, false)
            : await saveToDownloadDir(item.path, dir.uri, item.name, false);
          if (result.fallback) fallback = true;
        });
        // Whatever is still staged - the emptied directory, and anything
        // that could not be saved - would otherwise push the next bundle of
        // that name to `name (1)`.
        await removeStaged(savedPath).catch(() => undefined);
        setUsedFallback(fallback);
        setLanded(landing);
        return '';
      }
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
        if (device) markDeviceUsed(device.id).catch(() => undefined);
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
  const loose = folderOffer?.loose ?? null;

  // With a custom folder we can see other apps' files, so warn about a
  // same-name collision before accepting. (Default MediaStore Downloads keeps
  // the system's automatic renaming - other apps' files are not visible.)
  const accept = async () => {
    const dir = downloadDirRef.current;
    // A bundle has no single name to check: its items keep their own, and
    // those are only known once it has arrived.
    if (dir && targetName && !loose) {
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
      <Muted>{device ? deviceLabel(device) : code}</Muted>
      <TransferRoute kind="receive" direct={direct} />

      <Card>
        {phase === 'connecting' ? (
          <Muted>
            {device
              ? t('paired.receiveWaiting', { name: deviceLabel(device) })
              : t('receive.connecting')}
          </Muted>
        ) : null}

        {phase === 'message' && message !== null ? (
          <>
            <Subtitle>{t('text.received')}</Subtitle>
            <MessageBox text={message} />
            <PrimaryButton
              label={copiedText ? t('text.copied') : t('text.copy')}
              onPress={() => {
                Clipboard.setString(message);
                setCopiedText(true);
                setTimeout(() => setCopiedText(false), 1500);
              }}
            />
          </>
        ) : null}

        {phase === 'confirm' ? (
          <>
            <Subtitle>
              {loose
                ? t('files.incoming')
                : folderOffer
                  ? t('receive.incomingFolder')
                  : t('receive.incoming')}
            </Subtitle>
            <Text style={{ color: c.text, fontSize: fontSize.subtitle }}>
              {loose
                ? bundleText(t as any, 'summary', loose, {
                    size: formatSize(folderOffer?.numBytes ?? 0),
                  })
                : folderOffer
                ? t('folder.summary', {
                    name: folderOffer.dirName,
                    count: folderOffer.numFiles,
                    size: formatSize(folderOffer.numBytes),
                  })
                : `${offerName} · ${formatSize(offerSize)}`}
            </Text>
            <Muted>
              {loose
                ? t('files.acceptQuestion')
                : folderOffer
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
              {loose
                ? bundleText(t as any, 'receiving', loose)
                : folderOffer
                  ? t('receive.receivingFolder')
                  : t('receive.receiving')}
            </Subtitle>
            <ProgressBar pct={pct} />
            <Muted>{t('transfer.progress', { pct })}</Muted>
          </>
        ) : null}

        {phase === 'done' && landed ? (
          <>
            {/* One line says it all for a bundle: what was saved, and where.
                If some of it could not be saved it says how many made it, in
                the colour of a problem and not of a success. */}
            <Text
              style={{
                color:
                  landed.saved.files + landed.saved.folders < landed.expected
                    ? c.danger
                    : c.success,
                fontSize: fontSize.body,
              }}>
              {savedBundleText(t as any, {
                saved: landed.saved,
                expected: landed.expected,
                folder:
                  downloadDirRef.current && !usedFallback
                    ? downloadDirRef.current.label
                    : null,
              })}
            </Text>
            {usedFallback ? <Muted>{t('files.folderFallback')}</Muted> : null}
          </>
        ) : null}

        {phase === 'done' && !landed ? (
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
