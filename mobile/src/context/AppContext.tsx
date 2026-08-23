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
import { openDb, syncNow, isPaired, getPeerLabel, getAutoSync, setAutoSync as persistAutoSync, getRepoFileSyncNotice } from '../db';
import { SyncVersionMismatchError } from '../sync/client';
import { getMobileConfig } from '../config/settings';
import { setThemeScheme } from '../theme';

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
  hasSyncError: boolean;
  versionMismatch: VersionMismatch | null;
  repoFileSyncNotice: { skipped: boolean; message: string | null };
  autoSync: boolean;
  setAutoSync: (on: boolean) => void;
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
  const [autoSyncOn, setAutoSyncOn] = useState(true);
  const [dataVersion, setDataVersion] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const bumpData = useCallback(() => {
    setDataVersion((v) => v + 1);
  }, []);

  const refresh = useCallback(async () => {
    await openDb();
    setPaired(isPaired());
    setPeerLabel(getPeerLabel());
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
        (result.overwrites > 0 ? '，两端有一处内容先后改过，已自动对齐' : '');
      if (result.repoFileSkipped && result.repoFileMessage) {
        message += `\n${result.repoFileMessage}`;
      }
      setLastSyncMessage(message);
      setHasSyncError(false);
      setVersionMismatch(null);
      setRepoFileSyncNotice(getRepoFileSyncNotice());
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
    if (!paired || !autoSyncOn) return;
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
  }, [paired, autoSyncOn, triggerSync]);

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
      autoSync: autoSyncOn,
      setAutoSync,
      dataVersion,
      refresh,
      notifyDataChanged: bumpData,
      triggerSync,
    }),
    [ready, paired, peerLabel, syncing, syncStatus, lastSyncMessage, hasSyncError, versionMismatch, repoFileSyncNotice, autoSyncOn, setAutoSync, dataVersion, refresh, bumpData, triggerSync],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp 必须在 AppProvider 内使用');
  return ctx;
}
