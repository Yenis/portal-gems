import React, { useEffect, useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_SERVER_SETTINGS,
  availableServerChoices,
  fontSize,
  isCustomServerUsable,
  radius,
  setLanguage,
  spacing,
  themes,
  SUPPORTED_LANGUAGES,
  THEME_NAMES,
  type ServerChoice,
  type ServerSettings,
} from '@portalgems/core';
import { Card, PrimaryButton, Subtitle, Title } from '../components';
import { getSetting, setSetting } from '../native';
import { loadServerSettings, saveServerSettings } from '../server';
import { useTheme, useThemeControl } from '../theme';

const LANGUAGE_LABELS: Record<string, string> = {
  en: 'English',
  de: 'Deutsch',
  bs: 'Bosanski',
  ru: 'Русский',
  fr: 'Français',
  es: 'Español',
};

export default function SettingsScreen({
  onHome,
  scrollToServer,
}: {
  onHome: () => void;
  scrollToServer?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const c = useTheme();
  const { themeName, setThemeName } = useThemeControl();
  const [langOpen, setLangOpen] = useState(false);

  // Deep-link target: scroll to the server section when arriving from the
  // send-screen "Change server" shortcut.
  const scrollRef = useRef<ScrollView>(null);
  const [serverY, setServerY] = useState(0);
  useEffect(() => {
    if (scrollToServer && serverY > 0) {
      scrollRef.current?.scrollTo({ y: serverY - spacing(3), animated: true });
    }
  }, [scrollToServer, serverY]);

  const [server, setServer] = useState<ServerSettings>(DEFAULT_SERVER_SETTINGS);
  useEffect(() => {
    loadServerSettings().then(setServer);
  }, []);
  const updateServer = (next: ServerSettings) => {
    setServer(next);
    saveServerSettings(next).catch(() => undefined);
  };

  // First-visit helper: shown once until dismissed; reopenable via the info button.
  const [helpSeen, setHelpSeen] = useState(true); // assume seen until loaded (no flash)
  const [helpOpen, setHelpOpen] = useState(false);
  useEffect(() => {
    getSetting('pg-server-help-seen').then((v) => setHelpSeen(v === '1'));
  }, []);
  const dismissHelp = () => {
    setHelpSeen(true);
    setHelpOpen(false);
    setSetting('pg-server-help-seen', '1').catch(() => undefined);
  };
  const showHelp = !helpSeen || helpOpen;

  const chooseLanguage = (lng: string) => {
    setLanguage(lng);
    setSetting('language', lng).catch(() => undefined);
  };

  const serverKey = (choice: ServerChoice) =>
    choice === 'public'
      ? 'choicePublic'
      : choice === 'portalgems'
        ? 'choicePortalgems'
        : 'choiceCustom';

  return (
    <ScrollView
      ref={scrollRef}
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.container}>
      <Title onBack={onHome}>{t('settings.title')}</Title>

      <Card>
        <Subtitle>{t('settings.language')}</Subtitle>
        <Pressable
          onPress={() => setLangOpen(true)}
          accessibilityRole="button"
          style={[styles.row, { borderColor: c.border }]}>
          <Text style={{ color: c.text, fontSize: fontSize.body }}>
            {LANGUAGE_LABELS[i18n.language] ?? i18n.language}
          </Text>
          <Svg
            width={20}
            height={20}
            viewBox="0 0 24 24"
            fill="none"
            stroke={c.textMuted}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round">
            <Path d="M6 9l6 6 6-6" />
          </Svg>
        </Pressable>
      </Card>

      <Modal
        visible={langOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setLangOpen(false)}>
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setLangOpen(false)}>
          <View
            style={[
              styles.modalSheet,
              { backgroundColor: c.surface, borderColor: c.border },
            ]}>
            {SUPPORTED_LANGUAGES.map((lng) => (
              <Pressable
                key={lng}
                onPress={() => {
                  chooseLanguage(lng);
                  setLangOpen(false);
                }}
                style={[
                  styles.row,
                  {
                    borderColor: i18n.language === lng ? c.primary : c.border,
                    backgroundColor:
                      i18n.language === lng ? c.codeBg : 'transparent',
                  },
                ]}>
                <Text style={{ color: c.text, fontSize: fontSize.body }}>
                  {LANGUAGE_LABELS[lng]}
                </Text>
                {i18n.language === lng ? (
                  <Text style={{ color: c.primary, fontWeight: '700' }}>✓</Text>
                ) : null}
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>

      <Card>
        <Subtitle>{t('settings.theme')}</Subtitle>
        <Text style={{ color: c.textMuted, fontSize: fontSize.small }}>
          {t('settings.currentTheme')}: {t(`settings.themes.${themeName}`)}
        </Text>
        <View style={styles.swatchButtons}>
          {THEME_NAMES.map((name) => {
            const selected = themeName === name;
            return (
              <Pressable
                key={name}
                onPress={() => setThemeName(name)}
                accessibilityRole="button"
                accessibilityLabel={t(`settings.themes.${name}`)}
                accessibilityState={{ selected }}
                style={[
                  styles.swatchButton,
                  { borderColor: selected ? c.text : 'transparent' },
                ]}>
                <View
                  style={[
                    styles.swatchLarge,
                    { backgroundColor: themes[name].light.primary },
                  ]}
                />
              </Pressable>
            );
          })}
        </View>
      </Card>

      <View onLayout={(e) => setServerY(e.nativeEvent.layout.y)}>
      <Card>
        <View style={styles.serverHeader}>
          <Subtitle>{t('settings.server.title')}</Subtitle>
          <Pressable onPress={() => setHelpOpen(true)} hitSlop={10}>
            <Text style={{ color: c.primary, fontSize: fontSize.subtitle, fontWeight: '700' }}>
              ⓘ
            </Text>
          </Pressable>
        </View>
        <Text style={{ color: c.textMuted, fontSize: fontSize.small }}>
          {t('settings.server.hint')}
        </Text>
        {showHelp ? (
          <View style={[styles.helpCard, { backgroundColor: c.codeBg, borderColor: c.primary }]}>
            <Text
              style={{
                color: c.text,
                fontSize: fontSize.body,
                fontWeight: '700',
                marginBottom: spacing(1.5),
              }}>
              {t('explain.choosingTitle')}
            </Text>
            <Text style={{ color: c.text, fontSize: fontSize.small, lineHeight: fontSize.body * 1.4 }}>
              {t('explain.choosingBody')}
            </Text>
            <Pressable onPress={dismissHelp} style={styles.helpDismiss}>
              <Text style={{ color: c.primary, fontWeight: '700', fontSize: fontSize.body }}>
                {t('common.gotIt')}
              </Text>
            </Pressable>
          </View>
        ) : null}
        {availableServerChoices().map((choice) => {
          const selected = server.choice === choice;
          return (
            <Pressable
              key={choice}
              onPress={() => updateServer({ ...server, choice })}
              style={[
                styles.row,
                {
                  borderColor: selected ? c.primary : c.border,
                  backgroundColor: selected ? c.codeBg : 'transparent',
                },
              ]}>
              <View style={{ flex: 1, paddingRight: spacing(2) }}>
                <Text style={{ color: c.text, fontSize: fontSize.body }}>
                  {t(`settings.server.${serverKey(choice)}`)}
                </Text>
                <Text style={{ color: c.textMuted, fontSize: fontSize.small }}>
                  {t(`settings.server.${serverKey(choice)}Hint`)}
                </Text>
              </View>
              {selected ? (
                <Text style={{ color: c.primary, fontWeight: '700' }}>✓</Text>
              ) : null}
            </Pressable>
          );
        })}
        {server.choice === 'custom' ? (
          <View style={{ gap: spacing(2) }}>
            <Text style={{ color: c.textMuted, fontSize: fontSize.small }}>
              {t('settings.server.leaveBlankHint')}
            </Text>
            <Text style={{ color: c.textMuted, fontSize: fontSize.small }}>
              {t('settings.server.rendezvousLabel')}
            </Text>
            <TextInput
              style={[
                styles.input,
                { borderColor: c.border, color: c.text, backgroundColor: c.background },
              ]}
              value={server.customRendezvousUrl ?? ''}
              onChangeText={(v) => updateServer({ ...server, customRendezvousUrl: v })}
              placeholder="wss://relay.example/v1"
              placeholderTextColor={c.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={{ color: c.textMuted, fontSize: fontSize.small }}>
              {t('settings.server.transitLabel')}
            </Text>
            <TextInput
              style={[
                styles.input,
                { borderColor: c.border, color: c.text, backgroundColor: c.background },
              ]}
              value={server.customTransitUrl ?? ''}
              onChangeText={(v) => updateServer({ ...server, customTransitUrl: v })}
              placeholder="tcp://transit.example:4001"
              placeholderTextColor={c.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {!isCustomServerUsable(server) ? (
              <Text style={{ color: c.danger, fontSize: fontSize.small }}>
                {t('settings.server.invalidUrl')}
              </Text>
            ) : null}
          </View>
        ) : null}
      </Card>
      </View>

      <PrimaryButton label={t('common.done')} onPress={onHome} />
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(3),
  },
  swatchButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing(1),
  },
  swatchButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatchLarge: { width: 30, height: 30, borderRadius: 15 },
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    padding: spacing(6),
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  modalSheet: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing(4),
    gap: spacing(2),
  },
  serverHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  helpCard: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing(3),
    marginTop: spacing(1),
  },
  helpDismiss: {
    alignSelf: 'flex-end',
    marginTop: spacing(2),
    paddingVertical: spacing(1),
    paddingHorizontal: spacing(2),
  },
  input: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(3),
    fontSize: fontSize.small,
    fontFamily: 'monospace',
  },
});
