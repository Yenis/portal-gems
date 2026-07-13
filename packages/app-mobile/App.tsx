import React, { useEffect, useRef, useState } from 'react';
import {
  AppState,
  BackHandler,
  StatusBar,
  useColorScheme,
  View,
} from 'react-native';
import { initI18n, setLanguage, type PairedDevice } from '@portalgems/core';
import ExplainerScreen from './src/screens/ExplainerScreen';
import HomeScreen from './src/screens/HomeScreen';
import PairScreen from './src/screens/PairScreen';
import ReceiveScreen from './src/screens/ReceiveScreen';
import SendScreen from './src/screens/SendScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import { ThemeProvider, useTheme } from './src/theme';
import {
  consumePendingShare,
  copyToCache,
  deviceLocale,
  getSetting,
  type PickedFile,
} from './src/native';

initI18n(deviceLocale);
getSetting('language')
  .then((saved) => saved && setLanguage(saved))
  .catch(() => undefined);

type Route =
  | { name: 'home' }
  | { name: 'send'; file: PickedFile; device?: PairedDevice }
  | { name: 'receive'; code?: string; device?: PairedDevice }
  | { name: 'pair' }
  | { name: 'settings'; scrollToServer?: boolean }
  | { name: 'explain' };

export default function App() {
  const isDark = useColorScheme() === 'dark';
  return (
    <ThemeProvider>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      <AppShell />
    </ThemeProvider>
  );
}

function AppShell() {
  const c = useTheme();
  // A history stack, so the back arrow and Android's hardware/gesture back both
  // pop one page; at the root (home), hardware back falls through to the OS.
  const [stack, setStack] = useState<Route[]>([{ name: 'home' }]);
  const route = stack[stack.length - 1];

  const navigate = (r: Route) => setStack((s) => [...s, r]);
  const goBack = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  const goHome = () => setStack([{ name: 'home' }]);

  const depthRef = useRef(stack.length);
  depthRef.current = stack.length;
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (depthRef.current > 1) {
        goBack();
        return true; // handled - stay in the app
      }
      return false; // at home - let the OS background/exit as usual
    });
    return () => sub.remove();
  }, []);

  // "Share → PortalGems": pick up a shared file on launch and whenever the app
  // returns to the foreground, and jump straight into the send flow (with home
  // underneath, so back still works).
  useEffect(() => {
    const check = async () => {
      const uri = await consumePendingShare().catch(() => null);
      if (uri) {
        const file = await copyToCache(uri).catch(() => null);
        if (file) setStack([{ name: 'home' }, { name: 'send', file }]);
      }
    };
    check();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') check();
    });
    return () => sub.remove();
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      {route.name === 'home' ? (
        <HomeScreen
          onSend={(file, device) => navigate({ name: 'send', file, device })}
          onReceive={(code) => navigate({ name: 'receive', code })}
          onReceiveFrom={(device) => navigate({ name: 'receive', device })}
          onPair={() => navigate({ name: 'pair' })}
          onSettings={() => navigate({ name: 'settings' })}
          onExplain={() => navigate({ name: 'explain' })}
        />
      ) : route.name === 'send' ? (
        <SendScreen
          file={route.file}
          device={route.device}
          onHome={goBack}
          onServerSettings={() => navigate({ name: 'settings', scrollToServer: true })}
        />
      ) : route.name === 'receive' ? (
        <ReceiveScreen code={route.code} device={route.device} onHome={goBack} />
      ) : route.name === 'settings' ? (
        <SettingsScreen onHome={goBack} scrollToServer={route.scrollToServer} />
      ) : route.name === 'explain' ? (
        <ExplainerScreen onHome={goBack} />
      ) : (
        <PairScreen onHome={goBack} />
      )}
    </View>
  );
}
