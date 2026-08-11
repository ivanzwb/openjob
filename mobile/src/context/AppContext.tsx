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
import { openDb, syncNow, isPaired, listPendingConflicts, getPeerLabel } from '../db';
import type { FieldConflict } from '@shared/sync';

interface AppContextValue {
  ready: boolean;
  paired: boolean;
  peerLabel: string | null;
  syncing: boolean;
  syncStatus: string;
  lastSyncMessage: string | null;
  conflicts: FieldConflict[];
  refresh: () => Promise<void>;
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
  const [conflicts, setConflicts] = useState<FieldConflict[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    await openDb();
    setPaired(isPaired());
    setPeerLabel(getPeerLabel());
    setConflicts(listPendingConflicts());
  }, []);

  const triggerSync = useCallback(async () => {
    if (!isPaired()) return;
    setSyncing(true);
    try {
      const result = await syncNow();
      setLastSyncMessage(
        `同步完成：应用 ${result.applied} 条` +
          (result.conflicts > 0 ? `，${result.conflicts} 处冲突` : ''),
      );
      setConflicts(listPendingConflicts());
    } catch (e) {
      setLastSyncMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }, []);

  const triggerFullSync = useCallback(async () => {
    if (!isPaired()) return;
    setSyncing(true);
    try {
      const result = await syncNow({ full: true });
      setLastSyncMessage(
        `全量同步完成：应用 ${result.applied} 条` +
          (result.conflicts > 0 ? `，${result.conflicts} 处冲突` : ''),
      );
      setConflicts(listPendingConflicts());
    } catch (e) {
      setLastSyncMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }, []);

  useEffect(() => {
    void openDb()
      .then(() => refresh())
      .then(() => setReady(true));
  }, [refresh]);

  useEffect(() => {
    if (!paired) return;
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
  }, [paired, triggerSync]);

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
      conflicts,
      refresh,
      triggerSync,
      triggerFullSync,
    }),
    [ready, paired, peerLabel, syncing, syncStatus, lastSyncMessage, conflicts, refresh, triggerSync, triggerFullSync],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp 必须在 AppProvider 内使用');
  return ctx;
}
