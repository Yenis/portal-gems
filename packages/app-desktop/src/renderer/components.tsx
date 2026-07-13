import React from 'react';
import { fontSize, radius, spacing, type Palette } from '@portalgems/core';

export function Card({ c, children }: { c: Palette; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: c.surface,
        border: `1px solid ${c.border}`,
        borderRadius: radius.lg,
        padding: spacing(5),
        display: 'flex',
        flexDirection: 'column',
        gap: spacing(3),
      }}>
      {children}
    </div>
  );
}

export function Title({
  c,
  children,
  onBack,
}: {
  c: Palette;
  children: React.ReactNode;
  onBack?: () => void;
}) {
  const heading = (
    <h1 style={{ color: c.text, fontSize: fontSize.title, fontWeight: 700, margin: 0 }}>
      {children}
    </h1>
  );
  if (!onBack) return heading;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: spacing(2) }}>
      <span
        onClick={onBack}
        role="button"
        title="Back"
        style={{ cursor: 'pointer', display: 'inline-flex', color: c.text }}>
        <svg
          width={28}
          height={28}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round">
          <path d="M19 12H5" />
          <path d="M12 19l-7-7 7-7" />
        </svg>
      </span>
      {heading}
    </div>
  );
}

export function Subtitle({ c, children }: { c: Palette; children: React.ReactNode }) {
  return (
    <h2 style={{ color: c.text, fontSize: fontSize.subtitle, fontWeight: 600, margin: 0 }}>
      {children}
    </h2>
  );
}

export function Muted({ c, children }: { c: Palette; children: React.ReactNode }) {
  return (
    <p style={{ color: c.textMuted, fontSize: fontSize.body, lineHeight: 1.4, margin: 0 }}>
      {children}
    </p>
  );
}

const buttonBase: React.CSSProperties = {
  borderRadius: radius.md,
  padding: `${spacing(3)}px ${spacing(4)}px`,
  fontSize: fontSize.body,
  fontWeight: 600,
  cursor: 'pointer',
  width: '100%',
};

export function PrimaryButton({
  c,
  label,
  onClick,
  disabled,
}: {
  c: Palette;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...buttonBase,
        background: c.primary,
        color: c.onPrimary,
        border: 'none',
        opacity: disabled ? 0.45 : 1,
      }}>
      {label}
    </button>
  );
}

export function GhostButton({
  c,
  label,
  onClick,
  danger,
}: {
  c: Palette;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        ...buttonBase,
        background: 'transparent',
        color: danger ? c.danger : c.text,
        border: `1px solid ${c.border}`,
      }}>
      {label}
    </button>
  );
}

export function ProgressBar({ c, pct }: { c: Palette; pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div style={{ height: 10, borderRadius: 5, background: c.codeBg, overflow: 'hidden' }}>
      <div
        style={{
          height: '100%',
          width: `${clamped}%`,
          background: c.primary,
          borderRadius: 5,
          transition: 'width 120ms linear',
        }}
      />
    </div>
  );
}

export function CodeBox({ c, code }: { c: Palette; code: string }) {
  return (
    <div
      style={{
        background: c.codeBg,
        borderRadius: radius.md,
        padding: `${spacing(4)}px ${spacing(3)}px`,
        textAlign: 'center',
      }}>
      <span
        style={{
          color: c.text,
          fontFamily: 'monospace',
          fontSize: fontSize.code,
          fontWeight: 700,
          userSelect: 'all',
        }}>
        {code}
      </span>
    </div>
  );
}

export function TextInput({
  c,
  value,
  onChange,
  placeholder,
}: {
  c: Palette;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      spellCheck={false}
      style={{
        border: `1px solid ${c.border}`,
        borderRadius: radius.md,
        padding: spacing(3),
        fontSize: fontSize.body,
        fontFamily: 'monospace',
        background: c.background,
        color: c.text,
        width: '100%',
        boxSizing: 'border-box',
      }}
    />
  );
}
