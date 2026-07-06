import React, { useEffect, useState } from 'react';
import { AppState, StatusBar, useColorScheme, View } from 'react-native';
import { initI18n } from '@portalgems/core';
import HomeScreen from './src/screens/HomeScreen';
import ReceiveScreen from './src/screens/ReceiveScreen';
import SendScreen from './src/screens/SendScreen';
import { ThemeProvider } from './src/theme';
import { consumePendingShare, copyToCache, type PickedFile } from './src/native';

initI18n();

type Route =
  | { name: 'home' }
  | { name: 'send'; file: PickedFile }
  | { name: 'receive'; code: string };

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
            onSend={(file) => setRoute({ name: 'send', file })}
            onReceive={(code) => setRoute({ name: 'receive', code })}
          />
        ) : route.name === 'send' ? (
          <SendScreen file={route.file} onHome={goHome} />
        ) : (
          <ReceiveScreen code={route.code} onHome={goHome} />
        )}
      </View>
    </ThemeProvider>
  );
}
