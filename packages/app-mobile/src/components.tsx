import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { fontSize, radius, spacing } from '@portalgems/core';
import { useTheme } from './theme';

export function Card({ children }: { children: React.ReactNode }) {
  const c = useTheme();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: c.surface, borderColor: c.border },
      ]}>
      {children}
    </View>
  );
}

export function Title({
  children,
  onBack,
}: {
  children: React.ReactNode;
  onBack?: () => void;
}) {
  const c = useTheme();
  const text = <Text style={[styles.title, { color: c.text }]}>{children}</Text>;
  if (!onBack) return text;
  return (
    <View style={styles.titleRow}>
      <Pressable
        onPress={onBack}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel="Back">
        <Svg
          width={28}
          height={28}
          viewBox="0 0 24 24"
          fill="none"
          stroke={c.text}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round">
          <Path d="M19 12H5" />
          <Path d="M12 19l-7-7 7-7" />
        </Svg>
      </Pressable>
      {text}
    </View>
  );
}

export function Subtitle({ children }: { children: React.ReactNode }) {
  const c = useTheme();
  return <Text style={[styles.subtitle, { color: c.text }]}>{children}</Text>;
}

export function Muted({ children }: { children: React.ReactNode }) {
  const c = useTheme();
  return <Text style={[styles.muted, { color: c.textMuted }]}>{children}</Text>;
}

export function PrimaryButton({
  label,
  onPress,
  disabled,
  busy,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  const c = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: c.primary,
          opacity: disabled || busy ? 0.45 : pressed ? 0.8 : 1,
        },
      ]}>
      {busy ? (
        <ActivityIndicator color={c.onPrimary} />
      ) : (
        <Text style={[styles.buttonLabel, { color: c.onPrimary }]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function GhostButton({
  label,
  onPress,
  danger,
}: {
  label: string;
  onPress: () => void;
  danger?: boolean;
}) {
  const c = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        styles.ghost,
        { borderColor: c.border, opacity: pressed ? 0.7 : 1 },
      ]}>
      <Text style={[styles.buttonLabel, { color: danger ? c.danger : c.text }]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function ProgressBar({ pct }: { pct: number }) {
  const c = useTheme();
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <View style={[styles.progressTrack, { backgroundColor: c.codeBg }]}>
      <View
        style={[
          styles.progressFill,
          { backgroundColor: c.primary, width: `${clamped}%` },
        ]}
      />
    </View>
  );
}

export function CodeBox({ code }: { code: string }) {
  const c = useTheme();
  return (
    <View style={[styles.codeBox, { backgroundColor: c.codeBg }]}>
      <Text selectable style={[styles.code, { color: c.text }]}>
        {code}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing(5),
    gap: spacing(3),
  },
  title: { fontSize: fontSize.title, fontWeight: '700' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing(2) },
  subtitle: { fontSize: fontSize.subtitle, fontWeight: '600' },
  muted: { fontSize: fontSize.body, lineHeight: 21 },
  button: {
    borderRadius: radius.md,
    paddingVertical: spacing(3.5),
    alignItems: 'center',
    justifyContent: 'center',
  },
  ghost: { borderWidth: 1, backgroundColor: 'transparent' },
  buttonLabel: { fontSize: fontSize.body, fontWeight: '600' },
  progressTrack: {
    height: 10,
    borderRadius: 5,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', borderRadius: 5 },
  codeBox: {
    borderRadius: radius.md,
    paddingVertical: spacing(4),
    paddingHorizontal: spacing(3),
    alignItems: 'center',
  },
  code: {
    fontFamily: 'monospace',
    fontSize: fontSize.code,
    fontWeight: '700',
  },
});
