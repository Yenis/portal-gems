import React, { useEffect, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { pick } from '@react-native-documents/picker';
import {
  fontSize,
  radius,
  spacing,
  type PairedDevice,
} from '@portalgems/core';
import {
  Card,
  GhostButton,
  Muted,
  PrimaryButton,
  Subtitle,
  Title,
} from '../components';
import { copyToCache, type PickedFile } from '../native';
import { loadDevices, removeDevice } from '../pairing';
import { useTheme } from '../theme';

// Codes look like "7-crossover-clockwork": numeric nameplate, dash, words.
const CODE_RE = /^\d+(-[a-zA-Z0-9]+)+$/;

export default function HomeScreen({
  onSend,
  onReceive,
  onReceiveFrom,
  onPair,
}: {
  onSend: (file: PickedFile, device?: PairedDevice) => void;
  onReceive: (code: string) => void;
  onReceiveFrom: (device: PairedDevice) => void;
  onPair: () => void;
}) {
  const { t } = useTranslation();
  const c = useTheme();
  const [code, setCode] = useState('');
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const [devices, setDevices] = useState<PairedDevice[]>([]);

  useEffect(() => {
    loadDevices().then(setDevices);
  }, []);

  const pickFile = async (device?: PairedDevice) => {
    setPickError(null);
    setPicking(true);
    try {
      const [result] = await pick();
      const file = await copyToCache(result.uri);
      onSend(file, device);
    } catch (e: any) {
      // User closing the picker is not an error.
      if (e?.code !== 'OPERATION_CANCELED') {
        setPickError(t('errors.pickFailed'));
      }
    } finally {
      setPicking(false);
    }
  };

  const confirmRemove = (device: PairedDevice) => {
    Alert.alert(device.name, t('devices.remove'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('devices.remove'),
        style: 'destructive',
        onPress: () =>
          removeDevice(device.id).then(() => loadDevices().then(setDevices)),
      },
    ]);
  };

  const codeOk = CODE_RE.test(code.trim());

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.container}>
      <Title>{t('app.name')}</Title>
      <Muted>{t('home.tagline')}</Muted>

      <Card>
        <Subtitle>{t('home.devicesTitle')}</Subtitle>
        {devices.length === 0 ? <Muted>{t('home.devicesEmpty')}</Muted> : null}
        {devices.map((device) => (
          <View key={device.id} style={styles.deviceRow}>
            <Pressable
              style={styles.deviceName}
              onLongPress={() => confirmRemove(device)}>
              <Text
                numberOfLines={1}
                style={{ color: c.text, fontSize: fontSize.body, fontWeight: '600' }}>
                {device.name}
              </Text>
            </Pressable>
            <View style={styles.deviceButton}>
              <PrimaryButton
                label={t('devices.send')}
                onPress={() => pickFile(device)}
                disabled={picking}
              />
            </View>
            <View style={styles.deviceButton}>
              <GhostButton
                label={t('devices.receive')}
                onPress={() => onReceiveFrom(device)}
              />
            </View>
          </View>
        ))}
        <GhostButton label={t('home.pairNew')} onPress={onPair} />
      </Card>

      <Card>
        <Subtitle>{t('home.sendTitle')}</Subtitle>
        <Muted>{t('home.sendHint')}</Muted>
        <PrimaryButton
          label={t('home.sendButton')}
          onPress={() => pickFile()}
          busy={picking}
        />
        {pickError ? (
          <Text style={{ color: c.danger, fontSize: fontSize.small }}>
            {pickError}
          </Text>
        ) : null}
      </Card>

      <Card>
        <Subtitle>{t('home.receiveTitle')}</Subtitle>
        <Muted>{t('home.receiveHint')}</Muted>
        <TextInput
          style={[
            styles.input,
            {
              borderColor: c.border,
              color: c.text,
              backgroundColor: c.background,
            },
          ]}
          value={code}
          onChangeText={setCode}
          placeholder={t('home.receivePlaceholder')}
          placeholderTextColor={c.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <PrimaryButton
          label={t('home.receiveButton')}
          onPress={() => onReceive(code.trim())}
          disabled={!codeOk}
        />
      </Card>

      <View style={{ height: spacing(6) }} />
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
    fontSize: fontSize.body,
    fontFamily: 'monospace',
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(2),
  },
  deviceName: { flex: 1 },
  deviceButton: { width: 100 },
});
