import { useSyncExternalStore } from 'react';
import type { JobProgress } from '@shared/ipc';
import { onEvent } from './index';

interface JobState {
  active: JobProgress | null;
  lastMessage: string | null;
  lastError: string | null;
}

let state: JobState = { active: null, lastMessage: null, lastError: null };
const listeners = new Set<() => void>();
let subscribed = false;

function emit(): void {
  for (const listener of listeners) listener();
}

function ensureSubscription(): void {
  if (subscribed) return;
  subscribed = true;
  onEvent('job:progress', (p) => {
    state = {
      active: p.done ? null : p,
      lastMessage: p.error ? null : p.message,
      lastError: p.error ?? null,
    };
    emit();
  });
}

function subscribe(listener: () => void): () => void {
  ensureSubscription();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): JobState {
  return state;
}

/** 订阅诊断/索引类长任务进度；全局单例，页面切换不丢状态 */
export function useJobProgress(): JobState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
