import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { deviceLabel, spacing, type PairedDevice } from '@portalgems/core';
import { Card, GhostButton, Muted, PrimaryButton, Title } from '../components';
import { useTheme } from '../theme';

/**
 * Where a file shared into the app from another one should go: one of the
 * paired devices, or anyone at all through a one-time code. Nothing here
 * touches the network - the send only starts once a target is chosen.
 */
export default function ShareTargetScreen({
  name,
  devices,
  onChoose,
  onHome,
}: {
  name: string;
  devices: PairedDevice[];
  onChoose: (device?: PairedDevice) => void;
  onHome: () => void;
}) {
  const { t } = useTranslation();
  const c = useTheme();

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.container}>
      <Title onBack={onHome}>{t('shareTarget.title')}</Title>
      <Card>
        <Muted>{t('shareTarget.hint', { name })}</Muted>
        {devices.map((device) => (
          <PrimaryButton
            key={device.id}
            label={deviceLabel(device)}
            onPress={() => onChoose(device)}
          />
        ))}
        <GhostButton
          label={t('shareTarget.oneTimeCode')}
          onPress={() => onChoose()}
        />
      </Card>
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
