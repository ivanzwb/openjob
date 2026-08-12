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
import { openDb, syncNow, isPaired, listPendingConflicts, getPeerLabel, getAutoSync, setAutoSync as persistAutoSync, getRepoFileSyncNotice } from '../db';
import type { FieldConflict } from '@shared/sync';

interface AppContextValue {
  ready: boolean;
  paired: boolean;
  peerLabel: string | null;
  syncing: boolean;
  syncStatus: string;
  lastSyncMessage: string | null;
  /** 最近一次同步是否失败，同步页据此显示警示图标（不弹 alert） */
  hasSyncError: boolean;
  /** 代码库文件因空间不足被跳过时，同步页展示提示 */
  repoFileSyncNotice: { skipped: boolean; message: string | null };
  /** 自动同步开关：关闭后不再定时同步，也不在回前台时触发 */
  autoSync: boolean;
  setAutoSync: (on: boolean) => void;
  conflicts: FieldConflict[];
  /** 每次同步或本地数据变更后递增，供各屏重新读本地库 */
  dataVersion: number;
  refresh: () => Promise<void>;
  notifyDataChanged: () => void;
  triggerSync: () => Promise<void>;
  triggerFullSync: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [ready, setReady] = useState(false);
  const [paired, setPaired] = useState(false);
  const [peerLabel, setPeerLabel] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncMessage, setLastSyncMessage] = useState<string | null>(null);
  const [hasSyncError, setHasSyncError] = useState(false);
  const [repoFileSyncNotice, setRepoFileSyncNotice] = useState<{ skipped: boolean; message: string | null }>({
    skipped: false,
    message: null,
  });
  const [autoSync, setAutoSyncOn] = useState(true);
  const [conflicts, setConflicts] = useState<FieldConflict[]>([]);
  const [dataVersion, setDataVersion] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const bumpData = useCallback(() => {
    setDataVersion((v) => v + 1);
  }, []);

  const refresh = useCallback(async () => {
    await openDb();
    setPaired(isPaired());
    setPeerLabel(getPeerLabel());
    setConflicts(listPendingConflicts());
    setAutoSyncOn(getAutoSync());
    setRepoFileSyncNotice(getRepoFileSyncNotice());
  }, []);

  const triggerSync = useCallback(async () => {
    if (!isPaired()) return;
    setSyncing(true);
    try {
      const result = await syncNow();
      let message =
        `同步完成：应用 ${result.applied} 条` +
        (result.conflicts > 0 ? `，${result.conflicts} 处冲突` : '');
      if (result.repoFileSkipped && result.repoFileMessage) {
        message += `\n${result.repoFileMessage}`;
      }
      setLastSyncMessage(message);
      setHasSyncError(false);
      setRepoFileSyncNotice(getRepoFileSyncNotice());
      setConflicts(listPendingConflicts());
      bumpData();
    } catch (e) {
      setLastSyncMessage(e instanceof Error ? e.message : String(e));
      setHasSyncError(true);
    } finally {
      setSyncing(false);
    }
  }, [bumpData]);

  const triggerFullSync = useCallback(async () => {
    if (!isPaired()) return;
    setSyncing(true);
    try {
      const result = await syncNow({ full: true });
      let message =
        `全量同步完成：应用 ${result.applied} 条` +
        (result.conflicts > 0 ? `，${result.conflicts} 处冲突` : '');
      if (result.repoFileSkipped && result.repoFileMessage) {
        message += `\n${result.repoFileMessage}`;
      }
      setLastSyncMessage(message);
      setHasSyncError(false);
      setRepoFileSyncNotice(getRepoFileSyncNotice());
      setConflicts(listPendingConflicts());
      bumpData();
    } catch (e) {
      setLastSyncMessage(e instanceof Error ? e.message : String(e));
      setHasSyncError(true);
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
      repoFileSyncNotice,
      autoSync,
      setAutoSync,
      conflicts,
      dataVersion,
      refresh,
      notifyDataChanged: bumpData,
      triggerSync,
      triggerFullSync,
    }),
    [ready, paired, peerLabel, syncing, syncStatus, lastSyncMessage, hasSyncError, repoFileSyncNotice, autoSync, setAutoSync, conflicts, dataVersion, refresh, bumpData, triggerSync, triggerFullSync],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp 必须在 AppProvider 内使用');
  return ctx;
}
