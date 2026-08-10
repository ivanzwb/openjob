import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import type { PairingPayload } from '@shared/sync';
import { openDb, pairDesktop, syncNow } from './src/db';

export default function App() {
  const [ready, setReady] = useState(false);
  const [pairingText, setPairingText] = useState('');
  const [status, setStatus] = useState('未配对');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void openDb()
      .then(() => setReady(true))
      .catch((e) => setStatus(e instanceof Error ? e.message : String(e)));
  }, []);

  const parsePayload = (): PairingPayload => {
    const parsed = JSON.parse(pairingText) as PairingPayload;
    if (parsed.v !== 1 || !parsed.host || !parsed.port || !parsed.code) {
      throw new Error('配对 JSON 格式不正确');
    }
    return parsed;
  };

  const onPair = async (): Promise<void> => {
    setBusy(true);
    try {
      const payload = parsePayload();
      await pairDesktop(payload);
      setStatus(`已配对 ${payload.displayName}`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onSync = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await syncNow();
      setStatus(
        `同步完成：应用 ${result.applied} 条` +
          (result.conflicts > 0 ? `，${result.conflicts} 处冲突（桌面端处理）` : ''),
      );
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!ready) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
        <Text style={styles.muted}>正在初始化本地数据库…</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>openJob 手机端</Text>
      <Text style={styles.subtitle}>先在桌面端「设置 → 手机同步」生成配对码，再粘贴 JSON 完成配对。</Text>

      <TextInput
        style={styles.input}
        multiline
        placeholder='粘贴配对 JSON，例如 {"v":1,"host":"192.168.1.2","port":19721,...}'
        placeholderTextColor="#6b7280"
        value={pairingText}
        onChangeText={setPairingText}
      />

      <View style={styles.row}>
        <Pressable style={styles.button} onPress={() => void onPair()} disabled={busy}>
          <Text style={styles.buttonText}>配对</Text>
        </Pressable>
        <Pressable style={styles.buttonSecondary} onPress={() => void onSync()} disabled={busy}>
          <Text style={styles.buttonText}>立即同步</Text>
        </Pressable>
      </View>

      <Text style={styles.status}>{status}</Text>
      <StatusBar style="light" />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0b0d12' },
  container: {
    flexGrow: 1,
    backgroundColor: '#0b0d12',
    padding: 20,
    paddingTop: 56,
    gap: 12,
  },
  title: { color: '#f3f4f6', fontSize: 22, fontWeight: '600' },
  subtitle: { color: '#9ca3af', fontSize: 13, lineHeight: 20 },
  input: {
    minHeight: 120,
    borderWidth: 1,
    borderColor: '#374151',
    borderRadius: 8,
    padding: 12,
    color: '#f3f4f6',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  row: { flexDirection: 'row', gap: 8 },
  button: {
    flex: 1,
    backgroundColor: '#2563eb',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  buttonSecondary: {
    flex: 1,
    backgroundColor: '#374151',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  buttonText: { color: '#fff', fontWeight: '600' },
  status: { color: '#a7f3d0', fontSize: 13, lineHeight: 20 },
  muted: { color: '#9ca3af', marginTop: 8 },
});
