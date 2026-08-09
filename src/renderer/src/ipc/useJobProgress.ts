import { useEffect, useState } from 'react';
import type { JobProgress } from '@shared/ipc';
import { onEvent } from './index';

/** 订阅诊断类长任务的进度推送 */
export function useJobProgress(): {
  active: JobProgress | null;
  lastMessage: string | null;
  lastError: string | null;
} {
  const [active, setActive] = useState<JobProgress | null>(null);
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  useEffect(() => {
    return onEvent('job:progress', (p) => {
      setActive(p.done ? null : p);
      if (p.error) {
        setLastError(p.error);
        setLastMessage(null);
      } else {
        setLastMessage(p.message);
      }
    });
  }, []);

  return { active, lastMessage, lastError };
}
