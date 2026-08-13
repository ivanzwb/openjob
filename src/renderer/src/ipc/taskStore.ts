import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * 按 key 记录「正在跑的动作」的模块级仓库。
 *
 * 组件里的 useState 会随卸载消失：切换简历、换节点、关掉弹窗都会让按钮忘记自己在跑，
 * 回来时既看不到「进行中」，也拿不到已经跑完的结果。任务状态放在 React 树外面，
 * 按稳定的 key 存放，界面重新挂载后按同一个 key 就能接回去。
 *
 * 结果只在这里暂存一次（收件箱）：真正要留住的内容仍然由任务自己写库，
 * 这里只负责让还活着的界面立刻更新。
 */
export interface TaskState {
  running: boolean;
  error: string | null;
  /** 跑完但界面还没取走的结果 */
  hasResult: boolean;
  result: unknown;
}

const IDLE: TaskState = { running: false, error: null, hasResult: false, result: null };

const states = new Map<string, TaskState>();
const inflight = new Map<string, Promise<unknown>>();
const listeners = new Map<string, Set<() => void>>();

function emit(key: string): void {
  const set = listeners.get(key);
  if (!set) return;
  for (const listener of set) listener();
}

function update(key: string, patch: Partial<TaskState>): void {
  states.set(key, { ...(states.get(key) ?? IDLE), ...patch });
  emit(key);
}

function subscribe(key: string, listener: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listeners.delete(key);
  };
}

export function getTask(key: string): TaskState {
  return states.get(key) ?? IDLE;
}

export function isTaskRunning(key: string): boolean {
  return getTask(key).running;
}

/**
 * 跑一个带 key 的任务。同一个 key 正在跑时直接复用，避免重复点击发两次请求。
 * 返回的 promise 会正常抛错，调用方该自己 catch；仓库里也留一份错误文本，
 * 好让切回来的界面还能看到失败原因。
 */
export function runTask<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;

  update(key, { running: true, error: null });
  const promise = (async () => {
    try {
      const result = await fn();
      update(key, { running: false, error: null, hasResult: true, result });
      return result;
    } catch (err) {
      update(key, {
        running: false,
        error: err instanceof Error ? err.message : String(err),
        hasResult: false,
        result: null,
      });
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, promise);
  // 组件卸载后没人 await 也不该变成 unhandled rejection
  promise.catch(() => undefined);
  return promise;
}

/** 取走并清掉暂存的结果 */
export function claimTaskResult<T>(key: string): { hasResult: boolean; result: T | null } {
  const state = getTask(key);
  if (!state.hasResult) return { hasResult: false, result: null };
  update(key, { hasResult: false, result: null });
  return { hasResult: true, result: state.result as T };
}

export function clearTaskError(key: string): void {
  if (getTask(key).error) update(key, { error: null });
}

/** 订阅某个 key 的任务状态，按钮据此显示「进行中」与失败原因 */
export function useTask(key: string): TaskState {
  const sub = useCallback((listener: () => void) => subscribe(key, listener), [key]);
  const snapshot = useCallback(() => getTask(key), [key]);
  return useSyncExternalStore(sub, snapshot, snapshot);
}

/**
 * 认领任务结果：挂载时若有跑完还没人取的结果就立刻用上，
 * 于是「切走时还在跑、切回来已经跑完」也能把内容补上。
 */
export function useTaskResult<T>(key: string, adopt: (result: T) => void): void {
  const { hasResult } = useTask(key);
  const adoptRef = useRef(adopt);
  useEffect(() => {
    adoptRef.current = adopt;
  });
  useEffect(() => {
    if (!hasResult) return;
    const claimed = claimTaskResult<T>(key);
    if (claimed.hasResult) adoptRef.current(claimed.result as T);
  }, [key, hasResult]);
}
