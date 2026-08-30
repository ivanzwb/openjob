import { Linking, Platform, Pressable, Switch, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { runTask, useTaskState } from '../context/RemoteTaskContext';
import { useApp } from '../context/AppContext';
import {
  APP_UPDATE_CHECK_TASK,
  APP_UPDATE_INSTALL_TASK,
  RELEASES_PAGE_URL,
  checkForUpdate,
  downloadAndInstallApk,
  getCurrentVersion,
  useAppUpdateState,
} from '../update/appUpdate';
import { resolveFeedBase } from '../update/feedSource';
import { getMobileConfig } from '../config/settings';
import { useTheme } from '../theme';

function formatSize(bytes: number | null): string | null {
  if (!bytes || bytes <= 0) return null;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function AppUpdateCard(): React.JSX.Element {
  const theme = useTheme();
  const { check, percent } = useAppUpdateState();
  const checkTask = useTaskState(APP_UPDATE_CHECK_TASK);
  const installTask = useTaskState(APP_UPDATE_INSTALL_TASK);
  const { useSyncedFeed, setUseSyncedFeed } = useApp();

  const currentVersion = getCurrentVersion();
  const hasSyncedFeed = getMobileConfig().update.feedUrl.trim() !== '';
  // 开关关掉时即使桌面配了自定义源也只用官方 GitHub，文案与检测逻辑保持一致
  const feedBase = useSyncedFeed ? resolveFeedBase(getMobileConfig().update.feedUrl) : null;
  const latest = check?.latest ?? null;
  const hasUpdate = check?.hasUpdate ?? false;
  // iOS 装不了 APK，有新版也只能引导去发布页面，不能走到安装分支
  const canInstall = Platform.OS === 'android' && !!latest?.apkUrl;
  const publishedAt = formatDate(latest?.publishedAt ?? null);
  const apkSize = formatSize(latest?.apkSize ?? null);

  const startCheck = (): void => {
    // 返回文案而不是结果对象：runTask 会把字符串结果直接弹成 toast
    void runTask(APP_UPDATE_CHECK_TASK, '检查更新', async () => {
      const result = await checkForUpdate();
      if (!result.hasUpdate) return '已是最新版本';
      return `发现新版本 v${result.latest.version}`;
    }).catch(() => undefined);
  };

  const startInstall = (): void => {
    if (!latest || !canInstall) return;
    void runTask(APP_UPDATE_INSTALL_TASK, '下载更新', () => downloadAndInstallApk(latest)).catch(
      () => undefined,
    );
  };

  const openReleasePage = (): void => {
    void Linking.openURL(latest?.pageUrl ?? RELEASES_PAGE_URL).catch(() => undefined);
  };

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: theme.border,
        borderRadius: 8,
        padding: 12,
        backgroundColor: theme.surface,
        gap: 8,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Ionicons name="cloud-download-outline" size={16} color={theme.muted} />
        <Text style={{ flex: 1, color: theme.text, fontSize: 13, fontWeight: '600' }}>应用更新</Text>
        <Text style={{ color: theme.muted, fontSize: 11 }}>当前 v{currentVersion}</Text>
      </View>

      {feedBase ? (
        <Text
          style={{ color: theme.muted, fontSize: 10, lineHeight: 14 }}
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          更新源（同步自桌面）：{feedBase}
        </Text>
      ) : (
        <Text style={{ color: theme.muted, fontSize: 10, lineHeight: 14 }}>
          更新源：官方 GitHub Release
        </Text>
      )}

      {hasSyncedFeed && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            borderWidth: 1,
            borderColor: theme.border,
            borderRadius: 8,
            padding: 10,
            backgroundColor: theme.bg,
          }}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: theme.text, fontSize: 12, fontWeight: '600' }}>
              使用桌面同步的更新源
            </Text>
            <Text style={{ color: theme.muted, fontSize: 10, lineHeight: 14 }}>
              关闭后回官方 GitHub Release 检查更新
            </Text>
          </View>
          <Switch
            value={useSyncedFeed}
            onValueChange={setUseSyncedFeed}
            trackColor={{ false: theme.border, true: theme.accent }}
            thumbColor="#fff"
          />
        </View>
      )}

      {check && !hasUpdate && (
        <Text style={{ color: theme.muted, fontSize: 11, lineHeight: 16 }}>
          已是最新版本（最新发布 v{check.latest.version}）
        </Text>
      )}

      {check && hasUpdate && (
        <View style={{ gap: 4 }}>
          <Text style={{ color: theme.accent, fontSize: 12, fontWeight: '600' }}>
            发现新版本 v{check.latest.version}
          </Text>
          <Text style={{ color: theme.muted, fontSize: 11, lineHeight: 16 }}>
            {[publishedAt && `发布于 ${publishedAt}`, apkSize && `安装包 ${apkSize}`]
              .filter(Boolean)
              .join(' · ') || '发布信息不详'}
          </Text>
          {Platform.OS === 'android' && !latest?.apkUrl && (
            <Text style={{ color: theme.danger, fontSize: 11, lineHeight: 16 }}>
              这个版本没有挂 APK 安装包，请到发布页面手动下载
            </Text>
          )}
          {Platform.OS !== 'android' && (
            <Text style={{ color: theme.muted, fontSize: 11, lineHeight: 16 }}>
              iOS 无法安装 APK，请到发布页面获取对应版本
            </Text>
          )}
        </View>
      )}

      {installTask.running && (
        <View style={{ gap: 4 }}>
          <Text style={{ color: theme.muted, fontSize: 11 }}>
            {percent === null ? '下载中…' : `下载中 ${percent}%`}
          </Text>
          <View style={{ height: 4, borderRadius: 2, backgroundColor: theme.border }}>
            <View
              style={{
                height: 4,
                borderRadius: 2,
                backgroundColor: theme.accent,
                width: `${percent ?? 0}%`,
              }}
            />
          </View>
        </View>
      )}

      {(checkTask.error ?? installTask.error) && (
        <Text style={{ color: theme.danger, fontSize: 11, lineHeight: 16 }}>
          {checkTask.error ?? installTask.error}
        </Text>
      )}

      <Pressable
        onPress={startCheck}
        disabled={checkTask.running}
        style={{
          padding: 10,
          borderRadius: 8,
          alignItems: 'center',
          borderWidth: 1,
          borderColor: theme.border,
          backgroundColor: theme.bg,
          opacity: checkTask.running ? 0.6 : 1,
        }}
      >
        <Text style={{ color: theme.text, fontSize: 12 }}>
          {checkTask.running ? '检查中…' : '检查新版本'}
        </Text>
      </Pressable>

      {hasUpdate && canInstall && (
        <Pressable
          onPress={startInstall}
          disabled={installTask.running}
          style={{
            backgroundColor: theme.accent,
            padding: 10,
            borderRadius: 8,
            alignItems: 'center',
            opacity: installTask.running ? 0.6 : 1,
          }}
        >
          <Text style={{ color: '#fff', fontSize: 12 }}>
            {installTask.running ? '下载中…' : '下载并安装'}
          </Text>
        </Pressable>
      )}

      {hasUpdate && !canInstall && (
        <Pressable
          onPress={openReleasePage}
          style={{
            padding: 10,
            borderRadius: 8,
            alignItems: 'center',
            borderWidth: 1,
            borderColor: theme.accent,
            backgroundColor: theme.surface,
          }}
        >
          <Text style={{ color: theme.accent, fontSize: 12 }}>打开发布页面</Text>
        </Pressable>
      )}
    </View>
  );
}
