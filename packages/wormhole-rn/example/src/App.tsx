import { useRef, useState } from 'react';
import {
  Button,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  createTestFile,
  receiveFile,
  sendFile,
  type TransferListener,
} from 'wormhole-rn';

// Phase 0 spike: the example app's private files dir, hardcoded because the
// spike has no filesystem library. The real app resolves this natively.
const FILES_DIR = '/data/user/0/wormholern.example/files';

export default function App() {
  const [log, setLog] = useState<string[]>(['PortalGems Phase 0 spike ready']);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const lastPct = useRef(-1);

  const append = (line: string) =>
    setLog((prev) => [...prev, line].slice(-40));

  const listener: TransferListener = {
    onCode: (c) => append(`CODE: ${c}`),
    onTransit: (info) => append(`TRANSIT: ${info}`),
    onProgress: (done, total) => {
      const pct = total === 0n ? 100 : Number((done * 100n) / total);
      if (pct >= lastPct.current + 25 || pct === 100) {
        lastPct.current = pct;
        append(`PROGRESS: ${pct}%`);
      }
    },
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(true);
    lastPct.current = -1;
    append(`--- ${label} ---`);
    try {
      await fn();
      append(`${label}: OK`);
    } catch (e) {
      append(`${label}: ERROR ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const onSend = () =>
    run('SEND', async () => {
      const path = createTestFile(FILES_DIR, 256);
      append(`created ${path}`);
      await sendFile(path, undefined, listener);
    });

  const onReceive = () =>
    run('RECV', async () => {
      const saved = await receiveFile(code.trim(), FILES_DIR, listener);
      append(`saved ${saved}`);
    });

  return (
    <View style={styles.container}>
      <Text style={styles.title}>PortalGems - Phase 0</Text>
      <Button title="Send 256 KB test file" onPress={onSend} disabled={busy} />
      <TextInput
        style={styles.input}
        value={code}
        onChangeText={setCode}
        placeholder="wormhole code"
        autoCapitalize="none"
        autoCorrect={false}
        testID="code-input"
      />
      <Button
        title="Receive with code"
        onPress={onReceive}
        disabled={busy || code.trim().length === 0}
      />
      <ScrollView style={styles.log}>
        {log.map((line, i) => (
          <Text key={i} style={styles.logLine} testID={`log-${i}`}>
            {line}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: 60, paddingHorizontal: 16, gap: 12 },
  title: { fontSize: 20, fontWeight: 'bold', textAlign: 'center' },
  input: {
    borderWidth: 1,
    borderColor: '#999',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  log: { flex: 1, marginTop: 8 },
  logLine: { fontFamily: 'monospace', fontSize: 12 },
});
