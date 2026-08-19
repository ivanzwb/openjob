import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useToast } from '../components/Toast';

/**
 * 按 key 记录「正在跑的动作」的模块级仓库。
 *
 * 组件里的 useState 会随卸载消失：从简历编辑器退回列表、换考点、关掉弹窗都会
 * 让按钮忘记自己在跑，回来时既看不到「进行中」，也拿不到已经跑完的结果。
 * 状态放在 React 树外面按 key 存，界面重新挂载后用同一个 key 就能接回去。
 *
 * 结果只在这里暂存一次（收件箱）：真要留住的内容仍由任务自己写 SQLite，
 * 这里只负责让还活着的界面立刻更新。
 */
export interface TaskState {
  running: boolean;
  label: string | null;
  error: string | null;
  /** 跑完但界面还没取走的结果 */
  hasResult: boolean;
  result: unknown;
}

export interface ActiveTask {
  key: string;
  label: string;
  /** 同时在跑的任务数，用来提示后台还压着几件事 */
  count: number;
}

const IDLE: TaskState = { running: false, label: null, error: null, hasResult: false, result: null };

const states = new Map<string, TaskState>();
const inflight = new Map<string, Promise<unknown>>();
const listeners = new Map<string, Set<() => void>>();
const activeListeners = new Set<() => void>();
const groupListeners = new Map<string, Set<() => void>>();
const taskGroups = new Map<string, string>();
const runningGroups = new Map<string, Set<string>>();
/** 按开始顺序记录在跑的任务，头部这个用来给标题栏显示 */
let runningKeys: string[] = [];
let activeTask: ActiveTask | null = null;

type Notifier = (message: string, variant: 'success' | 'error') => void;
let notifier: Notifier | null = null;

function emit(key: string): void {
  const set = listeners.get(key);
  if (set) for (const listener of set) listener();
}

function refreshActive(): void {
  const key = runningKeys[0] ?? null;
  const label = key ? states.get(key)?.label ?? null : null;
  activeTask = key && label ? { key, label, count: runningKeys.length } : null;
  for (const listener of activeListeners) listener();
}

function emitGroup(group: string): void {
  const set = groupListeners.get(group);
  if (set) for (const listener of set) listener();
}

function groupCount(group: string): number {
  return runningGroups.get(group)?.size ?? 0;
}

function addToGroup(key: string, group: string | undefined): void {
  if (!group) return;
  let keys = runningGroups.get(group);
  if (!keys) {
    keys = new Set();
    runningGroups.set(group, keys);
  }
  keys.add(key);
  taskGroups.set(key, group);
  emitGroup(group);
}

function removeFromGroup(key: string): void {
  const group = taskGroups.get(key);
  if (!group) return;
  taskGroups.delete(key);
  const keys = runningGroups.get(group);
  keys?.delete(key);
  if (keys?.size === 0) runningGroups.delete(group);
  emitGroup(group);
}

function stateOf(key: string): TaskState {
  return states.get(key) ?? IDLE;
}

function update(key: string, patch: Partial<TaskState>): void {
  states.set(key, { ...stateOf(key), ...patch });
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

export interface RunTaskOptions {
  /** 关掉成功提示，比如结果已经直接体现在界面上 */
  toastSuccess?: boolean;
  /** 成功提示文案。结果是 id 这类不该给用户看的东西时必须给一个 */
  successMessage?: string;
  /** 把同类任务归组后可以按组限制并行数量 */
  group?: string;
  maxConcurrent?: number;
  limitMessage?: string;
}

/**
 * 跑一个带 key 的任务：同一个 key 正在跑时复用，避免重复点击发两次请求。
 * 失败会 toast 并抛出，仓库里也留一份错误文本，切回来还能看到失败原因。
 */
export function runTask<T>(
  key: string,
  label: string,
  fn: () => Promise<T>,
  options?: RunTaskOptions,
): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  if (
    options?.group &&
    options.maxConcurrent !== undefined &&
    groupCount(options.group) >= options.maxConcurrent
  ) {
    const message = options.limitMessage ?? `${label}任务已达并行上限`;
    notifier?.(message, 'error');
    return Promise.reject(new Error(message));
  }

  update(key, { running: true, label, error: null });
  runningKeys = [...runningKeys, key];
  addToGroup(key, options?.group);
  refreshActive();

  const promise = (async () => {
    try {
      const result = await fn();
      update(key, { running: false, error: null, hasResult: true, result });
      if (options?.toastSuccess !== false) {
        const fromResult = typeof result === 'string' && result.trim() ? result : `${label}完成`;
        notifier?.(options?.successMessage ?? fromResult, 'success');
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      update(key, { running: false, error: message, hasResult: false, result: null });
      notifier?.(message, 'error');
      throw err;
    } finally {
      inflight.delete(key);
      runningKeys = runningKeys.filter((k) => k !== key);
      removeFromGroup(key);
      refreshActive();
    }
  })();
  inflight.set(key, promise);
  // 组件卸载后没人 await 也不该变成 unhandled rejection
  promise.catch(() => undefined);
  return promise;
}

export function isTaskRunning(key: string): boolean {
  return stateOf(key).running;
}

export function runningTaskCount(group: string): number {
  return groupCount(group);
}

export function clearTaskError(key: string): void {
  if (stateOf(key).error) update(key, { error: null });
}

/** 订阅某个 key 的任务状态，按钮据此显示进行中与失败原因 */
export function useTaskState(key: string): TaskState {
  const sub = useCallback((listener: () => void) => subscribe(key, listener), [key]);
  const snapshot = useCallback(() => stateOf(key), [key]);
  return useSyncExternalStore(sub, snapshot, snapshot);
}

/**
 * 认领任务结果：挂载时若有跑完还没人取的结果就立刻用上，
 * 于是「切走时还在跑、切回来已经跑完」也能把内容补上。
 */
export function useTaskResult<T>(key: string, adopt: (result: T) => void): void {
  const { hasResult } = useTaskState(key);
  const adoptRef = useRef(adopt);
  useEffect(() => {
    adoptRef.current = adopt;
  });
  useEffect(() => {
    if (!hasResult) return;
    const snapshot = stateOf(key);
    // 同一个 key 可能有第二个消费者：结果已被取走就别再拿着 null 去 adopt
    if (!snapshot.hasResult) return;
    update(key, { hasResult: false, result: null });
    adoptRef.current(snapshot.result as T);
  }, [key, hasResult]);
}

function subscribeActive(listener: () => void): () => void {
  activeListeners.add(listener);
  return () => activeListeners.delete(listener);
}

function activeSnapshot(): ActiveTask | null {
  return activeTask;
}

/** 最早开始且还在跑的任务，标题栏用它提示后台还有活儿 */
export function useActiveTask(): ActiveTask | null {
  return useSyncExternalStore(subscribeActive, activeSnapshot, activeSnapshot);
}

function subscribeGroup(group: string, listener: () => void): () => void {
  let set = groupListeners.get(group);
  if (!set) {
    set = new Set();
    groupListeners.set(group, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) groupListeners.delete(group);
  };
}

export function useRunningTaskCount(group: string): number {
  const sub = useCallback((listener: () => void) => subscribeGroup(group, listener), [group]);
  const snapshot = useCallback(() => groupCount(group), [group]);
  return useSyncExternalStore(sub, snapshot, snapshot);
}

/** 把 toast 接到任务仓库上：任务在哪个页面跑完，提示都能弹出来 */
export function RemoteTaskProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const toast = useToast();
  useEffect(() => {
    notifier = (message, variant) => toast(message, { variant });
    return () => {
      notifier = null;
    };
  }, [toast]);
  return <>{children}</>;
}

/** 兼容旧用法：拿到当前活动任务与 runTask */
export function useRemoteTask(): {
  active: ActiveTask | null;
  runTask: typeof runTask;
} {
  const active = useActiveTask();
  return useMemo(() => ({ active, runTask }), [active]);
}
