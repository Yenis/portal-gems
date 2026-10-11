import React, { useEffect, useRef, useState } from 'react';
import {
  AppState,
  BackHandler,
  StatusBar,
  useColorScheme,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { initI18n, itemsText, setLanguage, type PairedDevice } from '@portalgems/core';
import ComposeScreen from './src/screens/ComposeScreen';
import ExplainerScreen from './src/screens/ExplainerScreen';
import AboutScreen from './src/screens/AboutScreen';
import GuideScreen from './src/screens/GuideScreen';
import HomeScreen from './src/screens/HomeScreen';
import PairScreen from './src/screens/PairScreen';
import ReceiveScreen from './src/screens/ReceiveScreen';
import SendScreen from './src/screens/SendScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import ShareTargetScreen from './src/screens/ShareTargetScreen';
import { loadDevices } from './src/pairing';
import { itemFromUris } from './src/picking';
import { ThemeProvider, useTheme } from './src/theme';
import {
  clearIncomingDir,
  consumePendingShare,
  deviceLocale,
  getSetting,
  type SendItem,
} from './src/native';

initI18n(deviceLocale);
getSetting('language')
  .then((saved) => saved && setLanguage(saved))
  .catch(() => undefined);
// Anything still in the staging directory is debris from a transfer the OS
// killed - the engine clears its own on failure and on cancel. Done here, at
// bundle load, because no screen exists yet to have a transfer in flight.
clearIncomingDir().catch(() => undefined);

type Route =
  | { name: 'home' }
  | { name: 'send'; item: SendItem; device?: PairedDevice }
  | { name: 'shareTarget'; item: SendItem; devices: PairedDevice[] }
  | { name: 'compose'; device?: PairedDevice }
  | { name: 'receive'; code?: string; device?: PairedDevice }
  | { name: 'pair' }
  | { name: 'settings'; scrollToServer?: boolean }
  | { name: 'explain' }
  | { name: 'guide' }
  | { name: 'about' };

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
  const { t } = useTranslation();
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
  // returns to the foreground. With paired devices there is a choice to make
  // first - one of them, or a one-time code; without any, it goes straight
  // into the send flow. Home stays underneath either way, so back still works.
  useEffect(() => {
    const check = async () => {
      const shared = await consumePendingShare().catch(() => []);
      if (shared.length === 0) return;
      // One shared file is a plain file send; several selected together are
      // one bundle - the same decision the picker makes.
      const item = await itemFromUris(
        shared.map((file) => file.uri),
        shared.map((file) => file.name)
      ).catch(() => null);
      if (!item) return;
      const devices = await loadDevices().catch(() => []);
      setStack([
        { name: 'home' },
        devices.length > 0 ? { name: 'shareTarget', item, devices } : { name: 'send', item },
      ]);
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
          onSend={(item, device) => navigate({ name: 'send', item, device })}
          onCompose={(device) => navigate({ name: 'compose', device })}
          onReceive={(code) => navigate({ name: 'receive', code })}
          onReceiveFrom={(device) => navigate({ name: 'receive', device })}
          onPair={() => navigate({ name: 'pair' })}
          onSettings={() => navigate({ name: 'settings' })}
          onExplain={() => navigate({ name: 'explain' })}
          onGuide={() => navigate({ name: 'guide' })}
          onAbout={() => navigate({ name: 'about' })}
        />
      ) : route.name === 'send' ? (
        <SendScreen
          item={route.item}
          device={route.device}
          onHome={goBack}
          onServerSettings={() => navigate({ name: 'settings', scrollToServer: true })}
        />
      ) : route.name === 'shareTarget' ? (
        <ShareTargetScreen
          name={
            route.item.kind === 'bundle'
              ? itemsText(t as any, { files: route.item.uris.length, folders: 0 })
              : route.item.kind === 'text'
                ? ''
                : route.item.name
          }
          devices={route.devices}
          onHome={goBack}
          // Replaces this screen rather than stacking on it, so leaving the
          // send lands on home and not back on a choice already made.
          onChoose={(device) =>
            setStack((s) => [
              ...s.slice(0, -1),
              { name: 'send', item: route.item, device },
            ])
          }
        />
      ) : route.name === 'compose' ? (
        <ComposeScreen
          onHome={goBack}
          onSend={(text) =>
            navigate({ name: 'send', item: { kind: 'text', text }, device: route.device })
          }
        />
      ) : route.name === 'receive' ? (
        <ReceiveScreen code={route.code} device={route.device} onHome={goBack} />
      ) : route.name === 'settings' ? (
        <SettingsScreen onHome={goBack} scrollToServer={route.scrollToServer} />
      ) : route.name === 'explain' ? (
        <ExplainerScreen onHome={goBack} />
      ) : route.name === 'guide' ? (
        <GuideScreen onHome={goBack} />
      ) : route.name === 'about' ? (
        <AboutScreen onHome={goBack} />
      ) : (
        <PairScreen
          onHome={goBack}
          // A first transfer started from the "paired" card takes that
          // screen's place, so leaving it lands on home.
          onSend={(item, device) =>
            setStack((s) => [...s.slice(0, -1), { name: 'send', item, device }])
          }
          onReceiveFrom={(device) =>
            setStack((s) => [...s.slice(0, -1), { name: 'receive', device }])
          }
        />
      )}
    </View>
  );
}
