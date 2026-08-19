import { useCallback, useRef, useState } from 'react';
import { Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import type { ConflictChoice, PairingPayload } from '@shared/sync';
import { listPendingConflictRows, pairDesktop, resolveConflicts, unpairDesktop } from '../db';
import type { PendingConflictRow } from '../db';
import { useApp } from '../context/AppContext';
import { runTask, useTaskState } from '../context/RemoteTaskContext';
import { AppUpdateCard } from '../components/AppUpdateCard';
import { useTheme } from '../theme';

function ConflictActions({
  row,
  onResolve,
}: {
  row: PendingConflictRow;
  onResolve: (row: PendingConflictRow, choice: ConflictChoice) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const { running } = useTaskState(`conflict:${row.id}`);
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <Pressable
        onPress={() => onResolve(row, 'local')}
        disabled={running}
        style={{ flex: 1, backgroundColor: theme.accent, padding: 8, borderRadius: 6, alignItems: 'center', opacity: running ? 0.6 : 1 }}
      >
        <Text style={{ color: '#fff', fontSize: 11 }}>{running ? '处理中…' : '保留本机'}</Text>
      </Pressable>
      <Pressable
        onPress={() => onResolve(row, 'remote')}
        disabled={running}
        style={{ flex: 1, backgroundColor: theme.surface, padding: 8, borderRadius: 6, alignItems: 'center', borderWidth: 1, borderColor: theme.border, opacity: running ? 0.6 : 1 }}
      >
        <Text style={{ color: theme.text, fontSize: 11 }}>{running ? '处理中…' : '采用对方'}</Text>
      </Pressable>
    </View>
  );
}

export function SyncScreen(): React.JSX.Element {
  const theme = useTheme();
  const { peerLabel, syncing, syncStatus, hasSyncError, repoFileSyncNotice, autoSync, setAutoSync, triggerSync, triggerFullSync, refresh } = useApp();
  const [conflicts, setConflicts] = useState<PendingConflictRow[]>([]);
  const [conflictsFor, setConflictsFor] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  // CameraView fires onBarcodeScanned repeatedly while a QR stays in view;
  // each callback previously spawned a parallel pair() fetch, so one scan
  // burst a queue of failure alerts. Only handle the first code per session.
  const scannedRef = useRef(false);

  const reloadConflicts = useCallback(() => {
    setConflicts(listPendingConflictRows());
  }, []);

  // 同步状态一变（含首次挂载）就重读冲突列表；渲染期比对比放进 effect 少一轮渲染
  if (conflictsFor !== syncStatus) {
    setConflictsFor(syncStatus);
    reloadConflicts();
  }

  const pair = async (raw: string): Promise<void> => {
    if (scannedRef.current) return;
    scannedRef.current = true;
    try {
      const parsed = JSON.parse(raw) as PairingPayload;
      if (parsed.v !== 1 || !parsed.host || !parsed.port || !parsed.code) {
        throw new Error('配对 JSON 格式不正确');
      }
      setPairError(null);
      await pairDesktop(parsed);
      setScanning(false);
      await refresh();
      await triggerFullSync();
      reloadConflicts();
    } catch (e) {
      // Leave the scanner regardless; surface the error in-page instead of
      // alert() so background fetch failures stop popping after exit.
      setScanning(false);
      setPairError(e instanceof Error ? e.message : String(e));
    }
  };

  // 冲突处理按行记：处理中切走再回来，这一行还是在处理中
  const resolve = (row: PendingConflictRow, choice: ConflictChoice): void => {
    void runTask(`conflict:${row.id}`, '处理冲突', async () => {
      await resolveConflicts(row.runId, [
        { table: row.table, rowId: row.rowId, field: row.field, choice },
      ]);
      await triggerSync();
      return '冲突已处理';
    })
      .then(() => reloadConflicts())
      .catch(() => undefined);
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
            void pair(data);
          }}
        />
        <Pressable
          onPress={() => {
            scannedRef.current = true;
            setScanning(false);
          }}
          style={{ position: 'absolute', top: 48, right: 16, backgroundColor: 'rgba(0,0,0,0.6)', padding: 10, borderRadius: 8 }}
        >
          <Text style={{ color: '#fff' }}>关闭</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ color: theme.muted }}>
        {peerLabel ?? '未配对 — 在桌面端设置中生成二维码'}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {hasSyncError && <Ionicons name="alert-circle" size={16} color={theme.danger} />}
        <Text style={{ color: hasSyncError ? theme.danger : theme.muted }}>
          状态: {syncStatus}
        </Text>
      </View>

      {pairError && (
        <View style={{ borderWidth: 1, borderColor: theme.danger, borderRadius: 8, padding: 10, backgroundColor: theme.surface, gap: 6 }}>
          <Text style={{ color: theme.danger, fontWeight: '600' }}>配对失败</Text>
          <Text style={{ color: theme.text, fontSize: 12 }}>{pairError}</Text>
        </View>
      )}

      {repoFileSyncNotice.skipped && repoFileSyncNotice.message && (
        <View style={{ borderWidth: 1, borderColor: theme.danger, borderRadius: 8, padding: 10, backgroundColor: theme.surface, gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Ionicons name="warning" size={16} color={theme.danger} />
            <Text style={{ color: theme.danger, fontWeight: '600' }}>代码库文件未同步</Text>
          </View>
          <Text style={{ color: theme.text, fontSize: 12, lineHeight: 18 }}>{repoFileSyncNotice.message}</Text>
          <Text style={{ color: theme.muted, fontSize: 11, lineHeight: 16 }}>
            请清理手机存储空间后再次同步；其他数据已正常同步。
          </Text>
        </View>
      )}

      {!peerLabel && (
        <Pressable
          onPress={() => {
            scannedRef.current = false;
            setPairError(null);
            setScanning(true);
          }}
          style={{ backgroundColor: theme.accent, padding: 12, borderRadius: 8, alignItems: 'center' }}
        >
          <Text style={{ color: '#fff' }}>扫描二维码配对</Text>
        </Pressable>
      )}

      {peerLabel && (
        <View style={{ gap: 8 }}>
          {/* 自动同步开关 */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              borderWidth: 1,
              borderColor: theme.border,
              borderRadius: 8,
              padding: 12,
              backgroundColor: theme.surface,
            }}
          >
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: theme.text, fontSize: 13, fontWeight: '600' }}>自动同步</Text>
              <Text style={{ color: theme.muted, fontSize: 11, lineHeight: 16 }}>
                每 60 秒后台同步一次，回到前台立即同步
              </Text>
            </View>
            <Switch
              value={autoSync}
              onValueChange={setAutoSync}
              trackColor={{ false: theme.border, true: theme.accent }}
              thumbColor="#fff"
            />
          </View>

          <Text style={{ color: theme.muted, fontSize: 11, lineHeight: 16 }}>
            目标：单用户多端无缝——所有业务数据与设置（含模型/API 配置）全量同步，手机可独立使用，不依赖电脑在线。
            {'\n'}当前：业务数据与配置已同步；手机可独立完成 JD 诊断、计划、讲解、考我、模拟面试、追问、读源码与仓库 Agent 问答。
            {'\n'}仍需桌面端：克隆/索引仓库（索引后源码快照会同步到手机）。
            {'\n'}暂不同步：搜索缓存（各端可重建）、仓库本机路径（各端路径不同）。
          </Text>
          <Pressable
            onPress={() => void triggerSync()}
            disabled={syncing}
            style={{ backgroundColor: theme.accent, padding: 12, borderRadius: 8, alignItems: 'center', opacity: syncing ? 0.6 : 1 }}
          >
            <Text style={{ color: '#fff' }}>{syncing ? '同步中…' : '立即同步'}</Text>
          </Pressable>
          <Pressable
            onPress={() => void triggerFullSync()}
            disabled={syncing}
            style={{ backgroundColor: theme.surface, padding: 12, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: theme.border, opacity: syncing ? 0.6 : 1 }}
          >
            <Text style={{ color: theme.text }}>{syncing ? '同步中…' : '全量同步'}</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              unpairDesktop();
              scannedRef.current = false;
              setPairError(null);
              void refresh();
            }}
            style={{ padding: 12, borderRadius: 8, alignItems: 'center' }}
          >
            <Text style={{ color: theme.muted }}>切换桌面端（重新配对）</Text>
          </Pressable>
        </View>
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
              <ConflictActions row={c} onResolve={resolve} />
            </View>
          ))}
        </View>
      )}

      {/* 更新与配对无关，放在最后一张卡：这里是手机端唯一的设置类页面 */}
      <AppUpdateCard />
    </ScrollView>
  );
}
