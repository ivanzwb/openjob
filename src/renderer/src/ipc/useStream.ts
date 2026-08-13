import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { ChatRequest, StreamDone, StreamToolCall, TokenUsage } from '@shared/ipc';
import type { Citation } from '@shared/entities';
import type { EvidenceKind } from '@shared/enums';
import { invoke, onEvent } from './index';

export interface StreamState {
  text: string;
  toolCalls: StreamToolCall[];
  citations: Citation[];
  evidenceKind: EvidenceKind;
  running: boolean;
  error: string | null;
  sessionId: string | null;
  usage: TokenUsage | null;
}

const EMPTY: StreamState = {
  text: '',
  toolCalls: [],
  citations: [],
  evidenceKind: 'model',
  running: false,
  error: null,
  sessionId: null,
  usage: null,
};

/**
 * 流式输出的状态放在 React 树外面，按 key 存。
 * 追问/源码问答的面板会随节点、页签切换卸载，状态留在组件里就会：
 * 回来时看不到「生成中」，中途的正文也没了。这里改成按 key 接回同一路流。
 */
const states = new Map<string, StreamState>();
/** key → 当前这一路流的 streamId */
const activeStreams = new Map<string, string>();
/** streamId → key，事件回来时用它找回属主 */
const streamOwners = new Map<string, string>();
const sessions = new Map<string, string | null>();
const doneHandlers = new Map<string, (payload: StreamDone) => void>();
const listeners = new Map<string, Set<() => void>>();

function emit(key: string): void {
  const set = listeners.get(key);
  if (!set) return;
  for (const listener of set) listener();
}

function stateOf(key: string): StreamState {
  return states.get(key) ?? EMPTY;
}

function update(key: string, patch: Partial<StreamState>): void {
  states.set(key, { ...stateOf(key), ...patch });
  emit(key);
}

function ownerOf(streamId: string): string | null {
  return streamOwners.get(streamId) ?? null;
}

function finish(key: string, streamId: string): void {
  activeStreams.delete(key);
  streamOwners.delete(streamId);
}

let subscribed = false;

function ensureSubscription(): void {
  if (subscribed) return;
  subscribed = true;

  onEvent('stream:delta', (p) => {
    const key = ownerOf(p.streamId);
    if (!key) return;
    update(key, { text: stateOf(key).text + p.delta });
  });

  onEvent('stream:tool', (p) => {
    const key = ownerOf(p.streamId);
    if (!key) return;
    update(key, { toolCalls: [...stateOf(key).toolCalls, p] });
  });

  onEvent('stream:done', (p) => {
    const key = ownerOf(p.streamId);
    if (!key) return;
    const sessionId = p.sessionId ?? sessions.get(key) ?? null;
    if (p.sessionId) sessions.set(key, p.sessionId);
    update(key, {
      text: p.contentMd || stateOf(key).text,
      citations: p.citations,
      evidenceKind: p.evidenceKind,
      running: false,
      sessionId,
      usage: p.usage,
    });
    finish(key, p.streamId);
    doneHandlers.get(key)?.(p);
  });

  onEvent('stream:error', (p) => {
    const key = ownerOf(p.streamId);
    if (!key) return;
    update(key, { running: false, error: p.message });
    finish(key, p.streamId);
  });
}

/**
 * 订阅一路 LLM 流式输出。
 * 主进程立即返回 streamId，内容通过 stream:* 事件推送；同一个 key 跨挂载共用一路流。
 */
export function useStream(
  /** 这一路流的稳定标识，如 `repoQa:<repoId>`、`chat:node:<nodeId>` */
  key: string,
  initialSessionId?: string | null,
  onDone?: (payload: StreamDone) => void,
): {
  state: StreamState;
  send: (req: ChatRequest) => Promise<void>;
  cancel: () => void;
  reset: () => void;
  setSessionId: (id: string | null) => void;
} {
  ensureSubscription();
  if (!states.has(key)) {
    states.set(key, { ...EMPTY, sessionId: initialSessionId ?? null });
    sessions.set(key, initialSessionId ?? null);
  }

  const subscribe = useCallback(
    (listener: () => void) => {
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
    },
    [key],
  );
  const snapshot = useCallback(() => stateOf(key), [key]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);

  // 流跑完时组件可能已经卸载，回调只保留最后一次注册的那个
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });
  useEffect(() => {
    doneHandlers.set(key, (payload) => onDoneRef.current?.(payload));
    return () => {
      if (doneHandlers.get(key)) doneHandlers.delete(key);
    };
  }, [key]);

  const send = useCallback(
    async (req: ChatRequest) => {
      const sid = req.sessionId ?? sessions.get(key) ?? undefined;
      states.set(key, { ...EMPTY, running: true, sessionId: sid ?? stateOf(key).sessionId });
      emit(key);
      try {
        const started = await invoke('llm:chat', { ...req, sessionId: sid });
        activeStreams.set(key, started.streamId);
        streamOwners.set(started.streamId, key);
        if (started.sessionId) {
          sessions.set(key, started.sessionId);
          update(key, { sessionId: started.sessionId });
        }
      } catch (err) {
        states.set(key, {
          ...EMPTY,
          sessionId: sessions.get(key) ?? null,
          error: err instanceof Error ? err.message : String(err),
        });
        emit(key);
      }
    },
    [key],
  );

  const cancel = useCallback(() => {
    const id = activeStreams.get(key);
    if (id) void invoke('llm:cancel', { streamId: id });
  }, [key]);

  const reset = useCallback(() => {
    sessions.set(key, null);
    states.set(key, EMPTY);
    emit(key);
  }, [key]);

  const setSessionId = useCallback(
    (id: string | null) => {
      sessions.set(key, id);
      update(key, { sessionId: id });
    },
    [key],
  );

  return { state, send, cancel, reset, setSessionId };
}
