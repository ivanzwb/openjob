import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';
import { openDb, syncNow, isPaired, listRecentOverwrites, getPeerLabel, getAutoSync, setAutoSync as persistAutoSync, getRepoFileSyncNotice, type OverwriteRow } from '../db';
import { SyncVersionMismatchError } from '../sync/client';
import { getMobileConfig } from '../config/settings';
import { setThemeScheme } from '../theme';

/** 两端版本不同、同步被桌面端拒绝时的详情，供同步页换成升级提示 */
export interface VersionMismatch {
  message: string;
  desktopVersion: string | null;
  mobileVersion: string;
}

interface AppContextValue {
  ready: boolean;
  paired: boolean;
  peerLabel: string | null;
  syncing: boolean;
  syncStatus: string;
  lastSyncMessage: string | null;
  /** 最近一次同步是否失败，同步页据此显示警示图标（不弹 alert） */
  hasSyncError: boolean;
  /**
   * 两端版本不同导致同步被拒。
   *
   * 与 hasSyncError 分开，因为这条不是「重试就好」的故障：不升级就永远不会通，
   * 界面要给的是升级指引而不是一行红字。
   */
  versionMismatch: VersionMismatch | null;
  /** 代码库文件因空间不足被跳过时，同步页展示提示 */
  repoFileSyncNotice: { skipped: boolean; message: string | null };
  /** 自动同步开关：关闭后不再定时同步，也不在回前台时触发 */
  autoSync: boolean;
  setAutoSync: (on: boolean) => void;
  /** 最近按更新时间自动取新、被覆盖掉的旧值，仅供查看 */
  overwrites: OverwriteRow[];
  /** 每次同步或本地数据变更后递增，供各屏重新读本地库 */
  dataVersion: number;
  refresh: () => Promise<void>;
  notifyDataChanged: () => void;
  triggerSync: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [ready, setReady] = useState(false);
  const [paired, setPaired] = useState(false);
  const [peerLabel, setPeerLabel] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncMessage, setLastSyncMessage] = useState<string | null>(null);
  const [hasSyncError, setHasSyncError] = useState(false);
  const [versionMismatch, setVersionMismatch] = useState<VersionMismatch | null>(null);
  const [repoFileSyncNotice, setRepoFileSyncNotice] = useState<{ skipped: boolean; message: string | null }>({
    skipped: false,
    message: null,
  });
  const [autoSync, setAutoSyncOn] = useState(true);
  const [overwrites, setOverwrites] = useState<OverwriteRow[]>([]);
  const [dataVersion, setDataVersion] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const bumpData = useCallback(() => {
    setDataVersion((v) => v + 1);
  }, []);

  const refresh = useCallback(async () => {
    await openDb();
    setPaired(isPaired());
    setPeerLabel(getPeerLabel());
    setOverwrites(listRecentOverwrites());
    setAutoSyncOn(getAutoSync());
    setRepoFileSyncNotice(getRepoFileSyncNotice());
  }, []);

  const triggerSync = useCallback(async () => {
    if (!isPaired()) return;
    setSyncing(true);
    try {
      const result = await syncNow();
      let message =
        (result.full ? '全表对账完成' : '同步完成') +
        `：应用 ${result.applied} 条` +
        (result.overwrites > 0 ? `，${result.overwrites} 处按时间取新` : '');
      if (result.repoFileSkipped && result.repoFileMessage) {
        message += `\n${result.repoFileMessage}`;
      }
      setLastSyncMessage(message);
      setHasSyncError(false);
      setVersionMismatch(null);
      setRepoFileSyncNotice(getRepoFileSyncNotice());
      setOverwrites(listRecentOverwrites());
      bumpData();
    } catch (e) {
      setLastSyncMessage(e instanceof Error ? e.message : String(e));
      setHasSyncError(true);
      setVersionMismatch(
        e instanceof SyncVersionMismatchError
          ? {
              message: e.message,
              desktopVersion: e.desktopVersion,
              mobileVersion: e.mobileVersion,
            }
          : null,
      );
    } finally {
      setSyncing(false);
    }
  }, [bumpData]);

  const setAutoSync = useCallback((on: boolean) => {
    setAutoSyncOn(on);
    persistAutoSync(on);
  }, []);

  useEffect(() => {
    void openDb()
      .then(() => refresh())
      .then(() => setReady(true));
  }, [refresh]);

  // 主题没有本机开关，跟着桌面同步下来的配置走：开库时读一次，之后每次同步再读
  useEffect(() => {
    setThemeScheme(getMobileConfig().ui.theme);
  }, [ready, dataVersion]);

  useEffect(() => {
    if (!paired || !autoSync) return;
    timer.current = setInterval(() => {
      void triggerSync();
    }, 60_000);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void triggerSync();
    });
    return () => {
      if (timer.current) clearInterval(timer.current);
      sub.remove();
    };
  }, [paired, autoSync, triggerSync]);

  const syncStatus = syncing
    ? '同步中…'
    : lastSyncMessage ?? (paired ? '已配对，等待同步' : '未配对');

  const value = useMemo(
    () => ({
      ready,
      paired,
      peerLabel,
      syncing,
      syncStatus,
      lastSyncMessage,
      hasSyncError,
      versionMismatch,
      repoFileSyncNotice,
      autoSync,
      setAutoSync,
      overwrites,
      dataVersion,
      refresh,
      notifyDataChanged: bumpData,
      triggerSync,
    }),
    [ready, paired, peerLabel, syncing, syncStatus, lastSyncMessage, hasSyncError, versionMismatch, repoFileSyncNotice, autoSync, setAutoSync, overwrites, dataVersion, refresh, bumpData, triggerSync],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp 必须在 AppProvider 内使用');
  return ctx;
}
