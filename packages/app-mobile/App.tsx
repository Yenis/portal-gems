import React, { useEffect, useState } from 'react';
import { AppState, StatusBar, useColorScheme, View } from 'react-native';
import { initI18n, setLanguage, type PairedDevice } from '@portalgems/core';
import ExplainerScreen from './src/screens/ExplainerScreen';
import HomeScreen from './src/screens/HomeScreen';
import PairScreen from './src/screens/PairScreen';
import ReceiveScreen from './src/screens/ReceiveScreen';
import SendScreen from './src/screens/SendScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import { ThemeProvider } from './src/theme';
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
  | { name: 'settings' }
  | { name: 'explain' };

export default function App() {
  const isDark = useColorScheme() === 'dark';
  const [route, setRoute] = useState<Route>({ name: 'home' });
  const goHome = () => setRoute({ name: 'home' });

  // "Share → PortalGems": pick up a shared file on launch and whenever the
  // app returns to the foreground, and jump straight into the send flow.
  useEffect(() => {
    const check = async () => {
      const uri = await consumePendingShare().catch(() => null);
      if (uri) {
        const file = await copyToCache(uri).catch(() => null);
        if (file) setRoute({ name: 'send', file });
      }
    };
    check();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') check();
    });
    return () => sub.remove();
  }, []);

  return (
    <ThemeProvider>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      <View style={{ flex: 1 }}>
        {route.name === 'home' ? (
          <HomeScreen
            onSend={(file, device) => setRoute({ name: 'send', file, device })}
            onReceive={(code) => setRoute({ name: 'receive', code })}
            onReceiveFrom={(device) => setRoute({ name: 'receive', device })}
            onPair={() => setRoute({ name: 'pair' })}
            onSettings={() => setRoute({ name: 'settings' })}
            onExplain={() => setRoute({ name: 'explain' })}
          />
        ) : route.name === 'send' ? (
          <SendScreen file={route.file} device={route.device} onHome={goHome} />
        ) : route.name === 'receive' ? (
          <ReceiveScreen code={route.code} device={route.device} onHome={goHome} />
        ) : route.name === 'settings' ? (
          <SettingsScreen onHome={goHome} />
        ) : route.name === 'explain' ? (
          <ExplainerScreen onHome={goHome} />
        ) : (
          <PairScreen onHome={goHome} />
        )}
      </View>
    </ThemeProvider>
  );
}
