import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useToast } from '../components/Toast';

interface RemoteTask {
  label: string;
  message: string | null;
}

interface RemoteTaskContextValue {
  active: RemoteTask | null;
  runTask: <T>(
    label: string,
    fn: () => Promise<T>,
    options?: { toastSuccess?: boolean },
  ) => Promise<T>;
}

const RemoteTaskContext = createContext<RemoteTaskContextValue | null>(null);

export function RemoteTaskProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [active, setActive] = useState<RemoteTask | null>(null);
  const toast = useToast();

  const runTask = useCallback(
    async <T,>(
      label: string,
      fn: () => Promise<T>,
      options?: { toastSuccess?: boolean },
    ): Promise<T> => {
      setActive({ label, message: '进行中…' });
      try {
        const result = await fn();
        if (options?.toastSuccess !== false) {
          const msg = typeof result === 'string' && result.trim() ? result : `${label}完成`;
          toast(msg, { variant: 'success' });
        }
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast(message, { variant: 'error' });
        throw err;
      } finally {
        setActive(null);
      }
    },
    [toast],
  );

  const value = useMemo(() => ({ active, runTask }), [active, runTask]);

  return <RemoteTaskContext.Provider value={value}>{children}</RemoteTaskContext.Provider>;
}

export function useRemoteTask(): RemoteTaskContextValue {
  const ctx = useContext(RemoteTaskContext);
  if (!ctx) throw new Error('useRemoteTask 必须在 RemoteTaskProvider 内使用');
  return ctx;
}
