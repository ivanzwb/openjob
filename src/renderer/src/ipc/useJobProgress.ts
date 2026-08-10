import { useSyncExternalStore } from 'react';
import type { JobProgress } from '@shared/ipc';
import { onEvent } from './index';

export interface JobResult {
  label: string;
  message: string;
  error: string | null;
}

interface JobState {
  active: JobProgress | null;
  lastResult: JobResult | null;
}

let state: JobState = { active: null, lastResult: null };
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
      lastResult: p.done
        ? { label: p.label, message: p.message, error: p.error }
        : state.lastResult,
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
export function useJobProgress(): JobState & {
  lastMessage: string | null;
  lastError: string | null;
} {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    ...snapshot,
    lastMessage:
      snapshot.lastResult && !snapshot.lastResult.error ? snapshot.lastResult.message : null,
    lastError: snapshot.lastResult?.error ?? null,
  };
}

/** 按任务标签读取进行中/完成状态，供按钮与局部反馈使用 */
export function useJobFeedback(label: string): {
  isRunning: boolean;
  progress: number | null;
  statusMessage: string | null;
  message: string | null;
  error: string | null;
} {
  const { active, lastResult } = useJobProgress();
  const isRunning = active?.label === label;
  const result = lastResult?.label === label ? lastResult : null;
  return {
    isRunning,
    progress: isRunning ? active!.progress : null,
    statusMessage: isRunning ? active!.message : null,
    message: result && !result.error ? result.message : null,
    error: result?.error ?? null,
  };
}
