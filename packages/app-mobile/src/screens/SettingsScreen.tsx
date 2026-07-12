import React, { useEffect, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
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
import { setSetting } from '../native';
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

export default function SettingsScreen({ onHome }: { onHome: () => void }) {
  const { t, i18n } = useTranslation();
  const c = useTheme();
  const { themeName, setThemeName } = useThemeControl();

  const [server, setServer] = useState<ServerSettings>(DEFAULT_SERVER_SETTINGS);
  useEffect(() => {
    loadServerSettings().then(setServer);
  }, []);
  const updateServer = (next: ServerSettings) => {
    setServer(next);
    saveServerSettings(next).catch(() => undefined);
  };

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
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.container}>
      <Title>{t('settings.title')}</Title>

      <Card>
        <Subtitle>{t('settings.language')}</Subtitle>
        {SUPPORTED_LANGUAGES.map((lng) => (
          <Pressable
            key={lng}
            onPress={() => chooseLanguage(lng)}
            style={[
              styles.row,
              {
                borderColor: i18n.language === lng ? c.primary : c.border,
                backgroundColor: i18n.language === lng ? c.codeBg : 'transparent',
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
      </Card>

      <Card>
        <Subtitle>{t('settings.theme')}</Subtitle>
        {THEME_NAMES.map((name) => (
          <Pressable
            key={name}
            onPress={() => setThemeName(name)}
            style={[
              styles.row,
              {
                borderColor: themeName === name ? c.primary : c.border,
                backgroundColor: themeName === name ? c.codeBg : 'transparent',
              },
            ]}>
            <View style={styles.swatchRow}>
              <View
                style={[
                  styles.swatch,
                  { backgroundColor: themes[name].light.primary },
                ]}
              />
              <Text style={{ color: c.text, fontSize: fontSize.body }}>
                {t(`settings.themes.${name}`)}
              </Text>
            </View>
            {themeName === name ? (
              <Text style={{ color: c.primary, fontWeight: '700' }}>✓</Text>
            ) : null}
          </Pressable>
        ))}
      </Card>

      <Card>
        <Subtitle>{t('settings.server.title')}</Subtitle>
        <Text style={{ color: c.textMuted, fontSize: fontSize.small }}>
          {t('settings.server.hint')}
        </Text>
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
  swatchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing(2.5) },
  swatch: { width: 18, height: 18, borderRadius: 9 },
  input: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(3),
    fontSize: fontSize.small,
    fontFamily: 'monospace',
  },
});
