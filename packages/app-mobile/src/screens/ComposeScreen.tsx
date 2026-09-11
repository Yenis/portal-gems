import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput } from 'react-native';
import { useTranslation } from 'react-i18next';
import { fontSize, radius, spacing } from '@portalgems/core';
import { Card, Muted, PrimaryButton, Subtitle, Title } from '../components';
import { useTheme } from '../theme';

/**
 * Write a message, then hand it to the ordinary send flow. Nothing here
 * touches the network: the code is only allocated once there is something to
 * send, so an abandoned draft never claims a nameplate.
 */
export default function ComposeScreen({
  onHome,
  onSend,
}: {
  onHome: () => void;
  onSend: (text: string) => void;
}) {
  const { t } = useTranslation();
  const c = useTheme();
  const [text, setText] = useState('');
  const ready = text.trim().length > 0;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        style={{ backgroundColor: c.background }}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled">
        <Title onBack={onHome}>{t('text.title')}</Title>
        <Card>
          <Subtitle>{t('text.compose')}</Subtitle>
          <TextInput
            style={[
              styles.input,
              {
                borderColor: c.border,
                color: c.text,
                backgroundColor: c.background,
              },
            ]}
            value={text}
            onChangeText={setText}
            placeholder={t('text.placeholder')}
            placeholderTextColor={c.textMuted}
            multiline
            textAlignVertical="top"
            autoFocus
          />
          <PrimaryButton
            label={t('text.sendButton')}
            onPress={() => onSend(text)}
            disabled={!ready}
          />
          {!ready ? <Muted>{t('text.empty')}</Muted> : null}
        </Card>
      </ScrollView>
    </KeyboardAvoidingView>
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
    minHeight: 140,
  },
});
