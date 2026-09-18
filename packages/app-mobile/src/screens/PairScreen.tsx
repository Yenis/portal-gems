import React, { useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Clipboard from '@react-native-clipboard/clipboard';
import QRCode from 'react-native-qrcode-svg';
import { sendText } from 'wormhole-rn';
import {
  deviceLabel,
  classifyPairingInput,
  createPairingPayload,
  encodePairingPayload,
  fontSize,
  parsePairingPayload,
  radius,
  spacing,
  type PairingPayload,
} from '@portalgems/core';
import {
  Card,
  CodeBox,
  GhostButton,
  Muted,
  PrimaryButton,
  Subtitle,
  Title,
} from '../components';
import { friendlyError } from '../errors';
import { scanQr } from '../native';
import { myDeviceName } from '../devicename';
import {
  completePairingAsScanner,
  NotAnInvitationError,
  receivePairingInvitation,
  waitForPairingAsDisplayer,
} from '../pairing';
import { currentServer } from '../server';
import { useTheme } from '../theme';

type Phase =
  | 'menu'
  | 'hosting'
  | 'showing'
  | 'scanning'
  | 'working'
  | 'done'
  | 'error';

export default function PairScreen({ onHome }: { onHome: () => void }) {
  const { t } = useTranslation();
  const c = useTheme();
  const [phase, setPhase] = useState<Phase>('menu');
  const [payload, setPayload] = useState<PairingPayload | null>(null);
  const [entry, setEntry] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [peerName, setPeerName] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const succeed = (name: string) => {
    setPeerName(name);
    setPhase('done');
  };
  const fail = (e: unknown) => {
    setError(friendlyError(t, e));
    setPhase('error');
  };

  // Once the other device holds the payload - scanned, pasted or received
  // over a code - this side waits for its handshake on the derived codes.
  const awaitHandshake = (p: PairingPayload, controller: AbortController) => {
    waitForPairingAsDisplayer(p, controller.signal).then(
      (device) => succeed(deviceLabel(device)),
      (e) => {
        if (!controller.signal.aborted) fail(e);
      }
    );
  };

  const show = async () => {
    const p = createPairingPayload(await myDeviceName());
    setPayload(p);
    setPhase('showing');
    const controller = new AbortController();
    abortRef.current = controller;
    awaitHandshake(p, controller);
  };

  // The alternative for a peer without a camera: allocate an ordinary
  // wormhole code and send the encoded payload through it as a text message.
  // When the send completes the other device has the payload, exactly as if
  // it had scanned the QR code.
  const hostWithCode = async () => {
    const p = createPairingPayload(await myDeviceName());
    const controller = new AbortController();
    abortRef.current = controller;
    setPairCode('');
    setPhase('hosting');
    try {
      const server = await currentServer();
      await sendText(
        encodePairingPayload(p),
        undefined,
        server,
        { onCode: setPairCode, onTransit: () => {}, onProgress: () => {} },
        { signal: controller.signal }
      );
    } catch (e) {
      if (!controller.signal.aborted) fail(e);
      return;
    }
    setPhase('working');
    awaitHandshake(p, controller);
  };

  const pairFromPayload = async (p: PairingPayload) => {
    const myName = await myDeviceName();
    setPhase('working');
    const controller = new AbortController();
    abortRef.current = controller;
    // Don't wait forever if the other side stopped listening.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 60_000);
    completePairingAsScanner(p, myName, controller.signal)
      .then(
        (device) => succeed(deviceLabel(device)),
        (e) => {
          if (timedOut) fail(new Error(t('paired.notOpen', { name: p.name })));
          else if (!controller.signal.aborted) fail(e);
        }
      )
      .finally(() => clearTimeout(timer));
  };

  const scan = async () => {
    setPhase('scanning');
    const raw = await scanQr().catch(() => null);
    if (raw == null) {
      setPhase('menu');
      return;
    }
    const p = parsePairingPayload(raw);
    if (!p) {
      setError(t('pair.invalidPayload'));
      setPhase('error');
      return;
    }
    void pairFromPayload(p);
  };

  // One field takes either the code from the other device or a pasted
  // payload.
  const join = async () => {
    const input = classifyPairingInput(entry);
    if (!input) {
      setError(t('pair.invalidPayload'));
      setPhase('error');
      return;
    }
    if (input.kind === 'payload') {
      void pairFromPayload(input.payload);
      return;
    }
    setPhase('working');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await pairFromPayload(await receivePairingInvitation(input.code, controller.signal));
    } catch (e) {
      if (controller.signal.aborted) return;
      if (e instanceof NotAnInvitationError) {
        setError(t('pair.notAnInvitation'));
        setPhase('error');
      } else {
        fail(e);
      }
    }
  };

  const copy = (value: string) => {
    Clipboard.setString(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const cancelAndBack = () => {
    abortRef.current?.abort();
    onHome();
  };

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled">
      <Title onBack={onHome}>{t('pair.title')}</Title>

      {phase === 'menu' || phase === 'scanning' ? (
        <>
          <Card>
            <PrimaryButton label={t('pair.showButton')} onPress={() => void show()} />
            <PrimaryButton label={t('pair.scanButton')} onPress={scan} />
          </Card>
          <Card>
            <Muted>{t('pair.codeSectionHint')}</Muted>
            <GhostButton label={t('pair.codeButton')} onPress={hostWithCode} />
            <TextInput
              style={[
                styles.input,
                {
                  borderColor: c.border,
                  color: c.text,
                  backgroundColor: c.background,
                },
              ]}
              value={entry}
              onChangeText={setEntry}
              placeholder={t('pair.entryPlaceholder')}
              placeholderTextColor={c.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <GhostButton
              label={t('pair.entryButton')}
              onPress={join}
              disabled={classifyPairingInput(entry) === null}
            />
          </Card>
        </>
      ) : null}

      {phase === 'hosting' ? (
        <Card>
          {pairCode ? (
            <>
              <Muted>{t('pair.codeHint')}</Muted>
              <CodeBox code={pairCode} />
              <PrimaryButton
                label={copied ? t('send.codeCopied') : t('send.copyCode')}
                onPress={() => copy(pairCode)}
              />
              <Muted>{t('pair.hostWaiting')}</Muted>
            </>
          ) : (
            <Muted>{t('receive.connecting')}</Muted>
          )}
        </Card>
      ) : null}

      {phase === 'showing' && payload ? (
        <Card>
          <Muted>{t('pair.showHint')}</Muted>
          <View style={styles.qrWrap}>
            <View style={styles.qrBox}>
              <QRCode value={encodePairingPayload(payload)} size={220} />
            </View>
          </View>
          <PrimaryButton
            label={copied ? t('pair.copied') : t('pair.copyPayload')}
            onPress={() => copy(encodePairingPayload(payload))}
          />
          <Muted>{t('pair.waiting')}</Muted>
        </Card>
      ) : null}

      {phase === 'working' ? (
        <Card>
          <Muted>{t('pair.waiting')}</Muted>
        </Card>
      ) : null}

      {phase === 'done' ? (
        <Card>
          <Subtitle>{t('pair.success', { name: peerName })}</Subtitle>
        </Card>
      ) : null}

      {phase === 'error' ? (
        <Card>
          <Subtitle>{t('errors.title')}</Subtitle>
          <Text style={{ color: c.danger, fontSize: fontSize.body }}>{error}</Text>
        </Card>
      ) : null}

      {phase === 'done' || phase === 'error' ? (
        <PrimaryButton label={t('common.done')} onPress={onHome} />
      ) : (
        <GhostButton label={t('common.cancel')} danger onPress={cancelAndBack} />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: spacing(5),
    paddingTop: spacing(14),
    gap: spacing(5),
  },
  input: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(3),
    fontSize: fontSize.small,
    fontFamily: 'monospace',
  },
  qrWrap: { alignItems: 'center' },
  qrBox: { backgroundColor: '#FFFFFF', padding: spacing(3), borderRadius: radius.md },
});
