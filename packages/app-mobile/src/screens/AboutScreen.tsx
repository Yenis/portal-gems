import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  componentLine,
  COMPONENTS,
  fontSize,
  SOURCE_URL,
  spacing,
} from '@portalgems/core';
import { Card, Muted, PrimaryButton, Subtitle, Title } from '../components';
import { appVersion } from '../native';
import { useTheme } from '../theme';

// The license notice the GPL asks for, where the source is, and what the app
// is built on. The address is text to select and copy, not a link, and the
// component list is one block of text: several hundred rows would otherwise
// be several hundred views.
export default function AboutScreen({ onHome }: { onHome: () => void }) {
  const { t } = useTranslation();
  const c = useTheme();

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.container}>
      <Title onBack={onHome}>{t('about.title')}</Title>
      <Muted>{t('about.version', { version: appVersion })}</Muted>
      <Card>
        <Subtitle>{t('about.licenseTitle')}</Subtitle>
        <Muted>{t('about.licenseBody')}</Muted>
      </Card>
      <Card>
        <Subtitle>{t('about.sourceTitle')}</Subtitle>
        <Muted>{t('about.sourceBody')}</Muted>
        <Text selectable style={[styles.mono, { color: c.text }]}>
          {SOURCE_URL}
        </Text>
      </Card>
      <Card>
        <Subtitle>{t('about.privacyTitle')}</Subtitle>
        <Muted>{t('about.privacyBody')}</Muted>
      </Card>
      <Card>
        <Subtitle>{t('about.componentsTitle')}</Subtitle>
        <Muted>{t('about.componentsBody')}</Muted>
        <Text selectable style={[styles.mono, { color: c.textMuted }]}>
          {COMPONENTS.android.map(componentLine).join('\n')}
        </Text>
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
  mono: { fontFamily: 'monospace', fontSize: fontSize.small },
});
