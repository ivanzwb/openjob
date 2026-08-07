import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatRequest, StreamToolCall } from '@shared/ipc';
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
}

const EMPTY: StreamState = {
  text: '',
  toolCalls: [],
  citations: [],
  evidenceKind: 'model',
  running: false,
  error: null,
};

/**
 * 订阅一次 LLM 流式输出。
 * 主进程立即返回 streamId，内容通过 stream:* 事件推送，这里按 streamId 过滤。
 */
export function useStream(): {
  state: StreamState;
  send: (req: ChatRequest) => Promise<void>;
  cancel: () => void;
  reset: () => void;
} {
  const [state, setState] = useState<StreamState>(EMPTY);
  const streamIdRef = useRef<string | null>(null);

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
      setState((s) => ({
        ...s,
        // 以 done 里的完整文本为准，避免个别 delta 丢失导致内容不全
        text: p.contentMd || s.text,
        citations: p.citations,
        evidenceKind: p.evidenceKind,
        running: false,
      }));
      streamIdRef.current = null;
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
  }, []);

  const send = useCallback(async (req: ChatRequest) => {
    setState({ ...EMPTY, running: true });
    try {
      const { streamId } = await invoke('llm:chat', req);
      streamIdRef.current = streamId;
    } catch (err) {
      setState({
        ...EMPTY,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const cancel = useCallback(() => {
    const id = streamIdRef.current;
    if (id) void invoke('llm:cancel', { streamId: id });
  }, []);

  const reset = useCallback(() => setState(EMPTY), []);

  return { state, send, cancel, reset };
}
