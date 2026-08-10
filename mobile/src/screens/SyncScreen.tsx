import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import type { PairingPayload } from '@shared/sync';
import type { ConflictChoice } from '@shared/sync';
import { listPendingConflictRows, pairDesktop, resolveConflicts, syncNow } from '../db';
import type { PendingConflictRow } from '../db';
import { useApp } from '../context/AppContext';
import { theme } from '../theme';

export function SyncScreen(): React.JSX.Element {
  const { peerLabel, syncStatus, triggerSync, refresh } = useApp();
  const [conflicts, setConflicts] = useState<PendingConflictRow[]>([]);
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();

  const reloadConflicts = useCallback(() => {
    setConflicts(listPendingConflictRows());
  }, []);

  useEffect(() => {
    reloadConflicts();
  }, [reloadConflicts, syncStatus]);

  const pair = async (raw: string) => {
    const parsed = JSON.parse(raw) as PairingPayload;
    if (parsed.v !== 1 || !parsed.host || !parsed.port || !parsed.code) {
      throw new Error('配对 JSON 格式不正确');
    }
    await pairDesktop(parsed);
    setScanning(false);
    await refresh();
    await syncNow();
    reloadConflicts();
  };

  const resolve = async (row: PendingConflictRow, choice: ConflictChoice) => {
    await resolveConflicts(row.runId, [
      { table: row.table, rowId: row.rowId, field: row.field, choice },
    ]);
    await triggerSync();
    reloadConflicts();
  };

  if (scanning) {
    if (!permission?.granted) {
      return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: theme.bg, padding: 20 }}>
          <Text style={{ color: theme.text, marginBottom: 12 }}>需要相机权限以扫描配对码</Text>
          <Pressable onPress={() => void requestPermission()} style={{ backgroundColor: theme.accent, padding: 12, borderRadius: 8 }}>
            <Text style={{ color: '#fff' }}>授权相机</Text>
          </Pressable>
          <Pressable onPress={() => setScanning(false)} style={{ marginTop: 16 }}>
            <Text style={{ color: theme.muted }}>取消</Text>
          </Pressable>
        </View>
      );
    }
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <CameraView
          style={{ flex: 1 }}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => {
            void pair(data).catch((e) => alert(e instanceof Error ? e.message : String(e)));
          }}
        />
        <Pressable onPress={() => setScanning(false)} style={{ position: 'absolute', top: 48, right: 16, backgroundColor: 'rgba(0,0,0,0.6)', padding: 10, borderRadius: 8 }}>
          <Text style={{ color: '#fff' }}>关闭</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ color: theme.text, fontSize: 20, fontWeight: '600' }}>同步</Text>
      <Text style={{ color: theme.muted }}>
        {peerLabel ?? '未配对 — 在桌面端设置中生成二维码'}
      </Text>
      <Text style={{ color: theme.muted }}>状态: {syncStatus}</Text>

      {!peerLabel && (
        <Pressable onPress={() => setScanning(true)} style={{ backgroundColor: theme.accent, padding: 12, borderRadius: 8, alignItems: 'center' }}>
          <Text style={{ color: '#fff' }}>扫描二维码配对</Text>
        </Pressable>
      )}

      {peerLabel && (
        <Pressable onPress={() => void triggerSync()} style={{ backgroundColor: theme.accent, padding: 12, borderRadius: 8, alignItems: 'center' }}>
          <Text style={{ color: '#fff' }}>立即同步</Text>
        </Pressable>
      )}

      {conflicts.length > 0 && (
        <View style={{ gap: 10 }}>
          <Text style={{ color: theme.danger, fontWeight: '600' }}>待解决冲突 ({conflicts.length})</Text>
          {conflicts.map((c) => (
            <View key={c.id} style={{ borderWidth: 1, borderColor: theme.border, borderRadius: 8, padding: 10, backgroundColor: theme.surface, gap: 6 }}>
              <Text style={{ color: theme.text, fontSize: 12 }}>{c.table} · {c.rowId}</Text>
              <Text style={{ color: theme.muted, fontSize: 10 }} numberOfLines={3}>
                {c.field}: local={JSON.stringify(c.localValue)} / remote={JSON.stringify(c.remoteValue)}
              </Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Pressable onPress={() => void resolve(c, 'local')} style={{ flex: 1, backgroundColor: theme.accent, padding: 8, borderRadius: 6, alignItems: 'center' }}>
                  <Text style={{ color: '#fff', fontSize: 11 }}>保留本机</Text>
                </Pressable>
                <Pressable onPress={() => void resolve(c, 'remote')} style={{ flex: 1, backgroundColor: theme.surface, padding: 8, borderRadius: 6, alignItems: 'center', borderWidth: 1, borderColor: theme.border }}>
                  <Text style={{ color: theme.text, fontSize: 11 }}>采用对方</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}
