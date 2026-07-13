import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { spacing } from '@portalgems/core';
import { Card, Muted, PrimaryButton, Subtitle, Title } from '../components';
import { useTheme } from '../theme';

const SECTIONS = [
  'codes',
  'e2e',
  'direct',
  'servers',
  'choosing',
  'pairing',
  'limits',
] as const;

export default function ExplainerScreen({ onHome }: { onHome: () => void }) {
  const { t } = useTranslation();
  const c = useTheme();

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.container}>
      <Title>{t('explain.title')}</Title>
      <Muted>{t('explain.intro')}</Muted>
      {SECTIONS.map((key) => (
        <Card key={key}>
          <Subtitle>{t(`explain.${key}Title`)}</Subtitle>
          <Muted>{t(`explain.${key}Body`)}</Muted>
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
