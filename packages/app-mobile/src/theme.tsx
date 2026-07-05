import React, { createContext, useContext } from 'react';
import { useColorScheme } from 'react-native';
import { themes, type Palette } from '@portalgems/core';

const ThemeContext = createContext<Palette>(themes.diamond.light);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const scheme = useColorScheme();
  const palette = themes.diamond[scheme === 'dark' ? 'dark' : 'light'];
  return <ThemeContext.Provider value={palette}>{children}</ThemeContext.Provider>;
}

export const useTheme = (): Palette => useContext(ThemeContext);
