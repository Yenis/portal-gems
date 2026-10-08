import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { spacing } from '@portalgems/core';
import { Card, Muted, PrimaryButton, Subtitle, Title } from '../components';
import { useTheme } from '../theme';

// What the app can do, as opposed to ExplainerScreen's how and why. A feature
// a user could miss belongs here; 'share' is this platform's own entry, where
// the desktop has 'drop'.
const SECTIONS = [
  'send',
  'receive',
  'pair',
  'devices',
  'share',
  'settings',
  'trouble',
] as const;

export default function GuideScreen({ onHome }: { onHome: () => void }) {
  const { t } = useTranslation();
  const c = useTheme();

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.container}>
      <Title onBack={onHome}>{t('guide.title')}</Title>
      <Muted>{t('guide.intro')}</Muted>
      {SECTIONS.map((key) => (
        <Card key={key}>
          <Subtitle>{t(`guide.${key}Title`)}</Subtitle>
          <Muted>{t(`guide.${key}Body`)}</Muted>
        </Card>
      ))}
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
});
