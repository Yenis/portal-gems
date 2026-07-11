import React, { createContext, useContext, useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';
import { themes, type Palette, type ThemeName } from '@portalgems/core';
import { getSetting, setSetting } from './native';

interface ThemeContextValue {
  palette: Palette;
  themeName: ThemeName;
  setThemeName: (name: ThemeName) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  palette: themes.diamond.light,
  themeName: 'diamond',
  setThemeName: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const scheme = useColorScheme();
  const [themeName, setThemeNameState] = useState<ThemeName>('diamond');

  useEffect(() => {
    getSetting('theme').then((saved) => {
      if (saved && saved in themes) setThemeNameState(saved as ThemeName);
    });
  }, []);

  const setThemeName = (name: ThemeName) => {
    setThemeNameState(name);
    setSetting('theme', name).catch(() => undefined);
  };

  const palette = themes[themeName][scheme === 'dark' ? 'dark' : 'light'];
  return (
    <ThemeContext.Provider value={{ palette, themeName, setThemeName }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = (): Palette => useContext(ThemeContext).palette;
export const useThemeControl = (): ThemeContextValue => useContext(ThemeContext);
