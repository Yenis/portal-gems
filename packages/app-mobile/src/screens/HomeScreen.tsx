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
import Svg, { Path } from 'react-native-svg';
import { useTranslation } from 'react-i18next';
import { pick } from '@react-native-documents/picker';
import {
  deviceLabel,
  fontSize,
  lastTransferText,
  radius,
  spacing,
  type PairedDevice,
  type ServerChoice,
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
import { loadServerSettings, SERVER_CHOICE_KEYS } from '../server';
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
  onGuide,
}: {
  onSend: (item: SendItem, device?: PairedDevice) => void;
  onCompose: (device?: PairedDevice) => void;
  onReceive: (code: string) => void;
  onReceiveFrom: (device: PairedDevice) => void;
  onPair: () => void;
  onSettings: () => void;
  onExplain: () => void;
  onGuide: () => void;
}) {
  const { t, i18n } = useTranslation();
  const c = useTheme();
  const [code, setCode] = useState('');
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  // A code only connects when both sides meet on the same server, so the
  // receive card names the one in use.
  const [serverChoice, setServerChoice] = useState<ServerChoice | null>(null);

  useEffect(() => {
    loadDevices().then(setDevices);
    loadServerSettings().then((s) => setServerChoice(s.choice));
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

  // One device open at a time, and none on launch: the quick actions on the
  // closed row are the common case, so there is nothing worth restoring.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // What a device's row reveals when opened. A new per-device action is one
  // more entry here; the grid below wraps to fit however many there are.
  const moreActions = (
    device: PairedDevice,
  ): { key: string; label: string; danger?: boolean; onPress: () => void }[] => [
    {
      key: 'sendFolder',
      label: t('devices.sendFolder'),
      onPress: () => pickFolder(device),
    },
    {
      key: 'sendText',
      label: t('devices.sendText'),
      onPress: () => onCompose(device),
    },
    {
      key: 'rename',
      label: t('devices.rename'),
      onPress: () => startRename(device),
    },
    {
      key: 'remove',
      label: t('devices.remove'),
      danger: true,
      onPress: () => confirmRemove(device),
    },
  ];

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
          <View
            key={device.id}
            style={[styles.device, { borderTopColor: c.border }]}>
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
                <View style={styles.deviceHeader}>
                  <Pressable
                    style={styles.deviceName}
                    onPress={() =>
                      setExpandedId(expandedId === device.id ? null : device.id)
                    }
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: expandedId === device.id }}>
                    <Svg
                      width={18}
                      height={18}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke={c.textMuted}
                      strokeWidth={2.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={
                        expandedId === device.id
                          ? { transform: [{ rotate: '90deg' }] }
                          : undefined
                      }>
                      <Path d="M9 6l6 6-6 6" />
                    </Svg>
                    <View style={styles.deviceNameLines}>
                      <Text
                        numberOfLines={1}
                        style={[styles.deviceNameText, { color: c.text }]}>
                        {deviceLabel(device)}
                      </Text>
                      {lastTransferText(t as any, device, i18n.language) ? (
                        <Text
                          numberOfLines={1}
                          style={[styles.deviceLastUsed, { color: c.textMuted }]}>
                          {lastTransferText(t as any, device, i18n.language)}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                  <View style={styles.quickActions}>
                    <View style={styles.quickAction}>
                      <PrimaryButton
                        compact
                        label={t('devices.send')}
                        onPress={() => pickFile(device)}
                        disabled={picking}
                      />
                    </View>
                    <View style={styles.quickAction}>
                      <GhostButton
                        compact
                        label={t('devices.receive')}
                        onPress={() => onReceiveFrom(device)}
                      />
                    </View>
                  </View>
                </View>
                {expandedId === device.id ? (
                  <View style={styles.moreActions}>
                    {moreActions(device).map((action) => (
                      <View key={action.key} style={styles.moreAction}>
                        <GhostButton
                          compact
                          label={action.label}
                          danger={action.danger}
                          onPress={action.onPress}
                        />
                      </View>
                    ))}
                  </View>
                ) : null}
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
        {serverChoice ? (
          <Muted>
            {t('home.receiveServer', {
              server: t(`settings.server.${SERVER_CHOICE_KEYS[serverChoice]}`),
            })}
          </Muted>
        ) : null}
        <PrimaryButton
          label={t('home.receiveButton')}
          onPress={() => onReceive(code.trim())}
          disabled={!codeOk}
        />
      </Card>

      <Card>
        <Subtitle>{t('home.moreTitle')}</Subtitle>
        <GhostButton label={t('home.explainLink')} onPress={onExplain} />
        <GhostButton label={t('home.guideLink')} onPress={onGuide} />
        <GhostButton label={t('home.settingsLink')} onPress={onSettings} />
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
  device: {
    gap: spacing(2),
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing(3),
  },
  // Name and quick actions share a line when they fit. When they do not (a
  // narrow phone, a long translation) the actions wrap below the name, and the
  // lopsided grow factors let them fill that line without stealing room from
  // the name while they sit beside it.
  deviceHeader: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing(2),
  },
  deviceName: {
    flexGrow: 1000,
    flexShrink: 1,
    flexBasis: 110,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(1),
    minHeight: 40,
  },
  deviceNameLines: { flexShrink: 1 },
  deviceNameText: { fontSize: fontSize.body, fontWeight: '600' },
  deviceLastUsed: { fontSize: fontSize.small },
  quickActions: { flexGrow: 1, flexDirection: 'row', gap: spacing(2) },
  quickAction: { flexGrow: 1 },
  // Two to a line, wrapping as actions are added; an odd one out takes the
  // full width.
  moreActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(2) },
  moreAction: { flexGrow: 1, flexBasis: '40%' },
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
