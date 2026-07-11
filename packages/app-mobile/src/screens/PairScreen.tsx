import React, { useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Clipboard from '@react-native-clipboard/clipboard';
import QRCode from 'react-native-qrcode-svg';
import {
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
  GhostButton,
  Muted,
  PrimaryButton,
  Subtitle,
  Title,
} from '../components';
import { friendlyError } from '../errors';
import { deviceName, scanQr } from '../native';
import {
  completePairingAsScanner,
  waitForPairingAsDisplayer,
} from '../pairing';
import { useTheme } from '../theme';

type Phase =
  | 'menu'
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
  const [manual, setManual] = useState('');
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

  const show = () => {
    const p = createPairingPayload(deviceName);
    setPayload(p);
    setPhase('showing');
    const controller = new AbortController();
    abortRef.current = controller;
    waitForPairingAsDisplayer(p, controller.signal).then(
      (device) => succeed(device.name),
      (e) => {
        if (!controller.signal.aborted) fail(e);
      }
    );
  };

  const pairFromPayload = (p: PairingPayload) => {
    setPhase('working');
    const controller = new AbortController();
    abortRef.current = controller;
    // Don't wait forever if the other side stopped listening.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 60_000);
    completePairingAsScanner(p, deviceName, controller.signal)
      .then(
        (device) => succeed(device.name),
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
    pairFromPayload(p);
  };

  const manualPair = () => {
    const p = parsePairingPayload(manual);
    if (!p) {
      setError(t('pair.invalidPayload'));
      setPhase('error');
      return;
    }
    pairFromPayload(p);
  };

  const copyPayload = () => {
    if (!payload) return;
    Clipboard.setString(encodePairingPayload(payload));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const cancelAndBack = () => {
    abortRef.current?.abort();
    onHome();
  };

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      <Title>{t('pair.title')}</Title>

      {phase === 'menu' || phase === 'scanning' ? (
        <Card>
          <PrimaryButton label={t('pair.showButton')} onPress={show} />
          <PrimaryButton label={t('pair.scanButton')} onPress={scan} />
          <TextInput
            style={[
              styles.input,
              {
                borderColor: c.border,
                color: c.text,
                backgroundColor: c.background,
              },
            ]}
            value={manual}
            onChangeText={setManual}
            placeholder={t('pair.manualPlaceholder')}
            placeholderTextColor={c.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <GhostButton
            label={t('pair.manualButton')}
            onPress={manualPair}
          />
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
            onPress={copyPayload}
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
