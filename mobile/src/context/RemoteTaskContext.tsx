import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

interface RemoteTask {
  label: string;
  message: string | null;
}

interface RemoteTaskContextValue {
  active: RemoteTask | null;
  lastMessage: string | null;
  lastError: string | null;
  runTask: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  clearStatus: () => void;
}

const RemoteTaskContext = createContext<RemoteTaskContextValue | null>(null);

export function RemoteTaskProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [active, setActive] = useState<RemoteTask | null>(null);
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const runTask = useCallback(async <T,>(label: string, fn: () => Promise<T>): Promise<T> => {
    setActive({ label, message: '进行中…' });
    setLastError(null);
    try {
      const result = await fn();
      setLastMessage(`${label}完成`);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLastError(message);
      throw err;
    } finally {
      setActive(null);
    }
  }, []);

  const clearStatus = useCallback(() => {
    setLastMessage(null);
    setLastError(null);
  }, []);

  const value = useMemo(
    () => ({ active, lastMessage, lastError, runTask, clearStatus }),
    [active, lastMessage, lastError, runTask, clearStatus],
  );

  return <RemoteTaskContext.Provider value={value}>{children}</RemoteTaskContext.Provider>;
}

export function useRemoteTask(): RemoteTaskContextValue {
  const ctx = useContext(RemoteTaskContext);
  if (!ctx) throw new Error('useRemoteTask 必须在 RemoteTaskProvider 内使用');
  return ctx;
}
