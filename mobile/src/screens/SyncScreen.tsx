import { useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import type { PairingPayload } from '@shared/sync';
import { backupReasonLabel } from '@shared/sync';
import {
  createManualBackup,
  deleteBackupFile,
  listBackups,
  pairDesktop,
  restoreFromBackup,
  unpairDesktop,
  type BackupInfo,
} from '../db';
import { useApp, type VersionMismatch } from '../context/AppContext';
import { SyncVersionMismatchError } from '../sync/client';
import { runTask } from '../context/RemoteTaskContext';
import { AppUpdateCard } from '../components/AppUpdateCard';
import { useTheme } from '../theme';

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function SyncScreen(): React.JSX.Element {
  const theme = useTheme();
  const {
    peerLabel,
    syncing,
    syncStatus,
    hasSyncError,
    versionMismatch,
    repoFileSyncNotice,
    autoSync,
    setAutoSync,
    triggerSync,
    refresh,
  } = useApp();
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [backupsFor, setBackupsFor] = useState<string | null>(null);
  const [showMoreBackups, setShowMoreBackups] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [pairMismatch, setPairMismatch] = useState<VersionMismatch | null>(null);
  // 配对与同步都可能因版本不一致被拒，提示内容一样，合成一处显示
  const mismatch = versionMismatch ?? pairMismatch;
  const [permission, requestPermission] = useCameraPermissions();
  // CameraView fires onBarcodeScanned repeatedly while a QR stays in view;
  // each callback previously spawned a parallel pair() fetch, so one scan
  // burst a queue of failure alerts. Only handle the first code per session.
  const scannedRef = useRef(false);

  // 同步状态一变（含首次挂载）就重读快照列表；渲染期比对比放进 effect 少一轮渲染
  if (backupsFor !== syncStatus) {
    setBackupsFor(syncStatus);
    setBackups(listBackups());
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
      setPairMismatch(null);
      await pairDesktop(parsed);
      setScanning(false);
      await refresh();
      // 首次配对水位线为 0，syncNow 自己会判定走全表对账
      await triggerSync();
    } catch (e) {
      // Leave the scanner regardless; surface the error in-page instead of
      // alert() so background fetch failures stop popping after exit.
      setScanning(false);
      if (e instanceof SyncVersionMismatchError) {
        // 版本不一致有专门的升级提示，再加一句「配对失败」只是噪音
        setPairMismatch({
          message: e.message,
          desktopVersion: e.desktopVersion,
          mobileVersion: e.mobileVersion,
        });
      } else {
        setPairError(e instanceof Error ? e.message : String(e));
      }
    }
  };

  const backupNow = (): void => {
    void runTask('backup:manual', '备份', async () => {
      const info = createManualBackup();
      return `已留一份快照（${formatSize(info.sizeBytes)}）`;
    })
      .then(() => setBackups(listBackups()))
      .catch(() => undefined);
  };

  const restore = (backup: BackupInfo): void => {
    Alert.alert(
      '回退到这份快照？',
      `${new Date(backup.createdAt).toLocaleString()} 的整库快照。当前数据会先自动留一份，回退后可以再退回来。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '回退',
          style: 'destructive',
          onPress: () => {
            void runTask(`restore:${backup.file}`, '回退快照', async () => {
              await restoreFromBackup(backup.file);
              await refresh();
              return '已回退到所选快照';
            })
              .then(() => setBackups(listBackups()))
              .catch(() => undefined);
          },
        },
      ],
    );
  };

  const deleteBackup = (backup: BackupInfo): void => {
    Alert.alert(
      '删除这份快照？',
      `${new Date(backup.createdAt).toLocaleString()} 的整库快照。只删备份文件，当前数据不受影响。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => {
            void runTask(`delete:${backup.file}`, '删除快照', async () => {
              deleteBackupFile(backup.file);
              return '已删除所选快照';
            })
              .then(() => setBackups(listBackups()))
              .catch(() => undefined);
          },
        },
      ],
    );
  };

  const cleanupOlderBackups = (): void => {
    const older = backups.slice(1);
    if (older.length === 0) return;
    Alert.alert(
      '清理较早的快照？',
      `将删除 ${older.length} 份较早快照，最新的一份会保留，当前数据不受影响。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '清理',
          style: 'destructive',
          onPress: () => {
            void runTask('backup:cleanup', '清理快照', async () => {
              for (const b of older) {
                deleteBackupFile(b.file);
              }
              return `已清理 ${older.length} 份较早的快照`;
            })
              .then(() => {
                setShowMoreBackups(false);
                setBackups(listBackups());
              })
              .catch(() => undefined);
          },
        },
      ],
    );
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

      {mismatch && (
        <View style={{ borderWidth: 1, borderColor: theme.danger, borderRadius: 8, padding: 10, backgroundColor: theme.surface, gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Ionicons name="warning" size={16} color={theme.danger} />
            <Text style={{ color: theme.danger, fontWeight: '600' }}>版本不一致，已停止同步</Text>
          </View>
          <Text style={{ color: theme.text, fontSize: 12, lineHeight: 18 }}>{mismatch.message}</Text>
          <Text style={{ color: theme.muted, fontSize: 11, lineHeight: 16 }}>
            手机端 v{mismatch.mobileVersion}
            {mismatch.desktopVersion ? ` · 桌面端 v${mismatch.desktopVersion}` : ''}
            {'\n'}本次没有改动任何数据。在下方「应用更新」里升级手机端，或把桌面端升到同一版本后会自动恢复同步。
          </Text>
        </View>
      )}

      {pairError && (
        <View style={{ borderWidth: 1, borderColor: theme.danger, borderRadius: 8, padding: 10, backgroundColor: theme.surface, gap: 6 }}>
          <Text style={{ color: theme.danger, fontWeight: '600' }}>配对失败</Text>
          <Text selectable style={{ color: theme.text, fontSize: 12 }}>
            {pairError}
          </Text>
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
            两端数据自动对齐，不需要选同步方式。改了同一行的不同字段，两边的修改都保留；
            改了同一个字段，保留较新的一份。
            {'\n'}仍需桌面端：克隆/索引仓库（索引后源码快照会同步到手机）。
            {'\n'}暂不同步：搜索缓存（各端可重建）、仓库本机路径（各端路径不同）。
          </Text>
          <Pressable
            onPress={() => void triggerSync()}
            disabled={syncing}
            style={{ backgroundColor: theme.accent, padding: 12, borderRadius: 8, alignItems: 'center', opacity: syncing ? 0.6 : 1 }}
          >
            <Text style={{ color: '#fff' }}>{syncing ? '同步中…' : '同步'}</Text>
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

      {peerLabel && (
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ color: theme.text, fontSize: 12, fontWeight: '600', flex: 1 }}>
              本机整库快照
            </Text>
            <Pressable
              onPress={backupNow}
              style={{ borderWidth: 1, borderColor: theme.border, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 }}
            >
              <Text style={{ color: theme.accent, fontSize: 11 }}>立即备份</Text>
            </Pressable>
          </View>
          <Text style={{ color: theme.muted, fontSize: 10 }}>
            同步前、升级数据库结构前都会自动留一份。默认只显示最新一份，较早的可在「更多」里查看或一次性清理。
          </Text>
          {backups.length === 0 ? (
            <Text style={{ color: theme.muted, fontSize: 11 }}>还没有快照</Text>
          ) : (
            <View style={{ gap: 8 }}>
              <BackupCard
                backup={backups[0]}
                theme={theme}
                onRestore={restore}
                onDelete={deleteBackup}
              />
              {backups.length > 1 && (
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Pressable
                    onPress={cleanupOlderBackups}
                    style={{ borderWidth: 1, borderColor: theme.border, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 }}
                  >
                    <Text style={{ color: theme.danger, fontSize: 11 }}>清理</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setShowMoreBackups((v) => !v)}
                    style={{ borderWidth: 1, borderColor: theme.border, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 }}
                  >
                    <Text style={{ color: theme.muted, fontSize: 11 }}>
                      {showMoreBackups ? '收起' : `更多（${backups.length - 1}）`}
                    </Text>
                  </Pressable>
                </View>
              )}
              {showMoreBackups &&
                backups.slice(1).map((b) => (
                  <BackupCard
                    key={b.file}
                    backup={b}
                    theme={theme}
                    onRestore={restore}
                    onDelete={deleteBackup}
                  />
                ))}
            </View>
          )}
        </View>
      )}

      {/* 更新与配对无关，放在最后一张卡：这里是手机端唯一的设置类页面 */}
      <AppUpdateCard />
    </ScrollView>
  );
}

function BackupCard({
  backup,
  theme,
  onRestore,
  onDelete,
}: {
  backup: BackupInfo;
  theme: ReturnType<typeof useTheme>;
  onRestore: (backup: BackupInfo) => void;
  onDelete: (backup: BackupInfo) => void;
}): React.JSX.Element {
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: theme.border,
        borderRadius: 8,
        padding: 10,
        backgroundColor: theme.surface,
        gap: 6,
      }}
    >
      <Text style={{ color: theme.text, fontSize: 12 }}>
        {new Date(backup.createdAt).toLocaleString()} · {backupReasonLabel(backup.reason)} ·{' '}
        {formatSize(backup.sizeBytes)}
      </Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pressable
          onPress={() => onRestore(backup)}
          style={{
            borderWidth: 1,
            borderColor: theme.border,
            borderRadius: 6,
            paddingHorizontal: 10,
            paddingVertical: 6,
          }}
        >
          <Text style={{ color: theme.danger, fontSize: 11 }}>回退到这份</Text>
        </Pressable>
        <Pressable
          onPress={() => onDelete(backup)}
          style={{
            borderWidth: 1,
            borderColor: theme.border,
            borderRadius: 6,
            paddingHorizontal: 10,
            paddingVertical: 6,
          }}
        >
          <Text style={{ color: theme.muted, fontSize: 11 }}>删除</Text>
        </Pressable>
      </View>
    </View>
  );
}
