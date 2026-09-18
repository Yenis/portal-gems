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
  deviceLabel,
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
import { copyToCache, pickSendFolder, type SendItem } from '../native';
import { loadDevices, removeDevice, renameDevice } from '../pairing';
import { useTheme } from '../theme';

// Codes look like "7-crossover-clockwork": numeric nameplate, dash, words.
const CODE_RE = /^\d+(-[a-zA-Z0-9]+)+$/;

export default function HomeScreen({
  onSend,
  onCompose,
  onReceive,
  onReceiveFrom,
  onPair,
  onSettings,
  onExplain,
}: {
  onSend: (item: SendItem, device?: PairedDevice) => void;
  onCompose: (device?: PairedDevice) => void;
  onReceive: (code: string) => void;
  onReceiveFrom: (device: PairedDevice) => void;
  onPair: () => void;
  onSettings: () => void;
  onExplain: () => void;
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
      onSend({ kind: 'file', ...file }, device);
    } catch (e: any) {
      // User closing the picker is not an error.
      if (e?.code !== 'OPERATION_CANCELED') {
        setPickError(t('errors.pickFailed'));
      }
    } finally {
      setPicking(false);
    }
  };

  const pickFolder = async (device?: PairedDevice) => {
    setPickError(null);
    setPicking(true);
    try {
      const folder = await pickSendFolder();
      if (folder) onSend({ kind: 'folder', ...folder }, device);
    } catch {
      setPickError(t('errors.pickFailed'));
    } finally {
      setPicking(false);
    }
  };

  // A local rename, edited in the row itself: React Native has no prompt
  // dialog on Android, and saving an empty field clears the rename so the
  // device goes back to the name it gave when pairing.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const startRename = (device: PairedDevice) => {
    setRenamingId(device.id);
    setRenameValue(device.label ?? '');
  };
  const commitRename = (device: PairedDevice) => {
    renameDevice(device.id, renameValue).then(() => {
      setRenamingId(null);
      loadDevices().then(setDevices);
    });
  };

  const confirmRemove = (device: PairedDevice) => {
    Alert.alert(deviceLabel(device), t('devices.removeConfirm'), [
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

      <View style={styles.linkRow}>
        <Pressable onPress={onExplain}>
          <Text style={{ color: c.primary, fontSize: fontSize.body, fontWeight: '600' }}>
            {t('home.explainLink')}
          </Text>
        </Pressable>
        <Pressable onPress={onSettings}>
          <Text style={{ color: c.primary, fontSize: fontSize.body, fontWeight: '600' }}>
            {t('home.settingsLink')}
          </Text>
        </Pressable>
      </View>

      <Card>
        <Subtitle>{t('home.devicesTitle')}</Subtitle>
        {devices.length === 0 ? <Muted>{t('home.devicesEmpty')}</Muted> : null}
        {devices.map((device) => (
          <View key={device.id} style={styles.device}>
            {renamingId === device.id ? (
              <>
                <TextInput
                  style={[
                    styles.renameInput,
                    { borderColor: c.border, color: c.text, backgroundColor: c.background },
                  ]}
                  value={renameValue}
                  onChangeText={setRenameValue}
                  placeholder={device.name}
                  placeholderTextColor={c.textMuted}
                  autoCapitalize="words"
                  autoCorrect={false}
                  autoFocus
                />
                <Muted>{t('devices.renameHint', { name: device.name })}</Muted>
                <View style={styles.deviceRow}>
                  <View style={styles.deviceButton}>
                    <PrimaryButton
                      label={t('common.save')}
                      onPress={() => commitRename(device)}
                    />
                  </View>
                  <View style={styles.deviceButton}>
                    <GhostButton
                      label={t('common.cancel')}
                      onPress={() => setRenamingId(null)}
                    />
                  </View>
                </View>
              </>
            ) : (
              <>
                <Text
                  numberOfLines={1}
                  style={{ color: c.text, fontSize: fontSize.body, fontWeight: '600' }}>
                  {deviceLabel(device)}
                </Text>
                <View style={styles.deviceRow}>
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
                <View style={styles.deviceRow}>
                  <View style={styles.deviceButton}>
                    <GhostButton
                      label={t('devices.rename')}
                      onPress={() => startRename(device)}
                    />
                  </View>
                  <View style={styles.deviceButton}>
                    <GhostButton
                      label={t('devices.remove')}
                      danger
                      onPress={() => confirmRemove(device)}
                    />
                  </View>
                </View>
              </>
            )}
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
        <GhostButton
          label={t('home.sendFolderButton')}
          onPress={() => pickFolder()}
          disabled={picking}
        />
        <GhostButton
          label={t('home.sendTextButton')}
          onPress={() => onCompose()}
          disabled={picking}
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
  linkRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: spacing(2),
  },
  device: { gap: spacing(2) },
  renameInput: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(2),
    fontSize: fontSize.body,
  },
  deviceRow: {
    flexDirection: 'row',
    // Stretch, not center: if a translated label wraps to two lines the three
    // buttons still end up the same height.
    alignItems: 'stretch',
    gap: spacing(2),
  },
  deviceButton: { flex: 1 },
});
