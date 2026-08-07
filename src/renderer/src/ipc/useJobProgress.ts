import { useEffect, useState } from 'react';
import type { JobProgress } from '@shared/ipc';
import { onEvent } from './index';

/** 订阅诊断类长任务的进度推送 */
export function useJobProgress(): {
  active: JobProgress | null;
  lastMessage: string | null;
} {
  const [active, setActive] = useState<JobProgress | null>(null);
  const [lastMessage, setLastMessage] = useState<string | null>(null);

  useEffect(() => {
    return onEvent('job:progress', (p) => {
      setActive(p.done ? null : p);
      setLastMessage(p.error ?? p.message);
    });
  }, []);

  return { active, lastMessage };
}
