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

export const THEME_NAMES: ThemeName[] = [
  'diamond',
  'sapphire',
  'emerald',
  'ruby',
  'amethyst',
];

const light = { success: '#2E7D32', danger: '#C62828' };
const dark = { success: '#81C784', danger: '#EF9A9A' };

export const themes: Record<ThemeName, Record<ThemeMode, Palette>> = {
  diamond: {
    light: {
      background: '#F6F7F9',
      surface: '#FFFFFF',
      text: '#171A20',
      textMuted: '#5F6774',
      primary: '#3D5A80',
      onPrimary: '#FFFFFF',
      border: '#E2E5EA',
      codeBg: '#EEF1F5',
      ...light,
    },
    dark: {
      background: '#12141A',
      surface: '#1C1F27',
      text: '#EDEFF3',
      textMuted: '#9AA3B0',
      primary: '#8FA9CE',
      onPrimary: '#12141A',
      border: '#2A2E38',
      codeBg: '#232733',
      ...dark,
    },
  },
  sapphire: {
    light: {
      background: '#F4F7FB',
      surface: '#FFFFFF',
      text: '#131A26',
      textMuted: '#56637A',
      primary: '#1D5FBF',
      onPrimary: '#FFFFFF',
      border: '#DEE6F2',
      codeBg: '#E8EFF9',
      ...light,
    },
    dark: {
      background: '#0D1420',
      surface: '#16202F',
      text: '#E8EEF7',
      textMuted: '#8FA0B8',
      primary: '#6FA3E8',
      onPrimary: '#0D1420',
      border: '#24334A',
      codeBg: '#1C2A3E',
      ...dark,
    },
  },
  emerald: {
    light: {
      background: '#F4FAF6',
      surface: '#FFFFFF',
      text: '#14201A',
      textMuted: '#55685E',
      primary: '#1E7A4E',
      onPrimary: '#FFFFFF',
      border: '#DCEBE2',
      codeBg: '#E7F4EC',
      ...light,
    },
    dark: {
      background: '#0E1713',
      surface: '#16241D',
      text: '#E7F2EB',
      textMuted: '#8CA69A',
      primary: '#5FC08F',
      onPrimary: '#0E1713',
      border: '#23392E',
      codeBg: '#1B2F25',
      ...dark,
    },
  },
  ruby: {
    light: {
      background: '#FBF5F6',
      surface: '#FFFFFF',
      text: '#241417',
      textMuted: '#705A5F',
      primary: '#B02A3C',
      onPrimary: '#FFFFFF',
      border: '#F0DCE0',
      codeBg: '#F7E9EC',
      ...light,
    },
    dark: {
      background: '#1A0F12',
      surface: '#261519',
      text: '#F5E9EB',
      textMuted: '#B3949B',
      primary: '#E17285',
      onPrimary: '#1A0F12',
      border: '#3E2630',
      codeBg: '#331E26',
      ...dark,
    },
  },
  amethyst: {
    light: {
      background: '#F8F5FB',
      surface: '#FFFFFF',
      text: '#1C1426',
      textMuted: '#635A70',
      primary: '#6E3BB2',
      onPrimary: '#FFFFFF',
      border: '#E7DEF2',
      codeBg: '#EFE8F7',
      ...light,
    },
    dark: {
      background: '#130E1C',
      surface: '#1D1629',
      text: '#EDE7F5',
      textMuted: '#9E8FB8',
      primary: '#A97FE0',
      onPrimary: '#130E1C',
      border: '#2F2444',
      codeBg: '#271D3A',
      ...dark,
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
