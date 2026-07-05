// PortalGems design tokens. Phase 1 ships the Diamond (neutral) theme in light
// and dark; Sapphire/Emerald/Ruby/Amethyst arrive with the theme picker phase.

export type ThemeMode = 'light' | 'dark';
export type ThemeName = 'diamond' | 'sapphire' | 'emerald' | 'ruby' | 'amethyst';

export interface Palette {
  background: string;
  surface: string;
  text: string;
  textMuted: string;
  primary: string;
  onPrimary: string;
  border: string;
  success: string;
  danger: string;
  codeBg: string;
}

export const themes: Record<'diamond', Record<ThemeMode, Palette>> = {
  diamond: {
    light: {
      background: '#F6F7F9',
      surface: '#FFFFFF',
      text: '#171A20',
      textMuted: '#5F6774',
      primary: '#3D5A80',
      onPrimary: '#FFFFFF',
      border: '#E2E5EA',
      success: '#2E7D32',
      danger: '#C62828',
      codeBg: '#EEF1F5',
    },
    dark: {
      background: '#12141A',
      surface: '#1C1F27',
      text: '#EDEFF3',
      textMuted: '#9AA3B0',
      primary: '#8FA9CE',
      onPrimary: '#12141A',
      border: '#2A2E38',
      success: '#81C784',
      danger: '#EF9A9A',
      codeBg: '#232733',
    },
  },
};

export const spacing = (n: number): number => n * 4;

export const radius = { sm: 6, md: 10, lg: 16 } as const;

export const fontSize = {
  title: 24,
  subtitle: 17,
  body: 15,
  small: 13,
  code: 20,
} as const;
