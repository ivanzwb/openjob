import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatRequest, StreamDone, StreamToolCall } from '@shared/ipc';
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
}

const EMPTY: StreamState = {
  text: '',
  toolCalls: [],
  citations: [],
  evidenceKind: 'model',
  running: false,
  error: null,
  sessionId: null,
};

/**
 * 订阅一次 LLM 流式输出。
 * 主进程立即返回 streamId，内容通过 stream:* 事件推送，这里按 streamId 过滤。
 */
export function useStream(
  initialSessionId?: string | null,
  onDone?: (payload: StreamDone) => void,
): {
  state: StreamState;
  send: (req: ChatRequest) => Promise<void>;
  cancel: () => void;
  reset: () => void;
  setSessionId: (id: string | null) => void;
} {
  const [state, setState] = useState<StreamState>({
    ...EMPTY,
    sessionId: initialSessionId ?? null,
  });
  const streamIdRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | null>(initialSessionId ?? null);

  useEffect(() => {
    const matches = (id: string): boolean => streamIdRef.current === id;

    const offDelta = onEvent('stream:delta', (p) => {
      if (!matches(p.streamId)) return;
      setState((s) => ({ ...s, text: s.text + p.delta }));
    });

    const offTool = onEvent('stream:tool', (p) => {
      if (!matches(p.streamId)) return;
      setState((s) => ({ ...s, toolCalls: [...s.toolCalls, p] }));
    });

    const offDone = onEvent('stream:done', (p) => {
      if (!matches(p.streamId)) return;
      const sid = p.sessionId ?? sessionIdRef.current;
      if (p.sessionId) sessionIdRef.current = p.sessionId;
      setState((s) => ({
        ...s,
        text: p.contentMd || s.text,
        citations: p.citations,
        evidenceKind: p.evidenceKind,
        running: false,
        sessionId: sid,
      }));
      streamIdRef.current = null;
      onDone?.(p);
    });

    const offError = onEvent('stream:error', (p) => {
      if (!matches(p.streamId)) return;
      setState((s) => ({ ...s, running: false, error: p.message }));
      streamIdRef.current = null;
    });

    return () => {
      offDelta();
      offTool();
      offDone();
      offError();
    };
  }, [onDone]);

  const send = useCallback(async (req: ChatRequest) => {
    const sid = req.sessionId ?? sessionIdRef.current ?? undefined;
    setState((s) => ({
      ...EMPTY,
      running: true,
      sessionId: sid ?? s.sessionId,
    }));
    try {
      const started = await invoke('llm:chat', { ...req, sessionId: sid });
      streamIdRef.current = started.streamId;
      if (started.sessionId) {
        sessionIdRef.current = started.sessionId;
        setState((s) => ({ ...s, sessionId: started.sessionId }));
      }
    } catch (err) {
      setState({
        ...EMPTY,
        sessionId: sessionIdRef.current,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const cancel = useCallback(() => {
    const id = streamIdRef.current;
    if (id) void invoke('llm:cancel', { streamId: id });
  }, []);

  const reset = useCallback(() => {
    sessionIdRef.current = null;
    setState(EMPTY);
  }, []);

  const setSessionId = useCallback((id: string | null) => {
    sessionIdRef.current = id;
    setState((s) => ({ ...s, sessionId: id }));
  }, []);

  return { state, send, cancel, reset, setSessionId };
}
