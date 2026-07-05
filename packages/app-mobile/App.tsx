import React, { useState } from 'react';
import { StatusBar, useColorScheme, View } from 'react-native';
import { initI18n } from '@portalgems/core';
import HomeScreen from './src/screens/HomeScreen';
import ReceiveScreen from './src/screens/ReceiveScreen';
import SendScreen from './src/screens/SendScreen';
import { ThemeProvider } from './src/theme';
import type { PickedFile } from './src/native';

initI18n();

type Route =
  | { name: 'home' }
  | { name: 'send'; file: PickedFile }
  | { name: 'receive'; code: string };

export default function App() {
  const isDark = useColorScheme() === 'dark';
  const [route, setRoute] = useState<Route>({ name: 'home' });
  const goHome = () => setRoute({ name: 'home' });

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
