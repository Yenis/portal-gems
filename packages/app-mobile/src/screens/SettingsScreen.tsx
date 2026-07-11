import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  fontSize,
  radius,
  setLanguage,
  spacing,
  themes,
  SUPPORTED_LANGUAGES,
  THEME_NAMES,
} from '@portalgems/core';
import { Card, PrimaryButton, Subtitle, Title } from '../components';
import { setSetting } from '../native';
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

  const chooseLanguage = (lng: string) => {
    setLanguage(lng);
    setSetting('language', lng).catch(() => undefined);
  };

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
});
