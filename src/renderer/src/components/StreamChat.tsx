import { useCallback, useEffect, useState } from 'react';
import type { LlmRole, SessionKind } from '@shared/enums';
import type { SessionMessageView, SessionSummary } from '@shared/ipc';
import { useStream } from '../ipc/useStream';
import { invoke } from '../ipc';
import { CitationList, SourceBadge } from './SourceBadge';
import { ToolTrace } from './ToolTrace';

/**
 * 流式对话组件，支持会话历史落库与回看。
 */
export function StreamChat({
  role = 'explain',
  systemPrompt,
  placeholder = '问点什么…',
  sessionKind = 'freeChat',
  campaignId,
}: {
  role?: LlmRole;
  systemPrompt?: string;
  placeholder?: string;
  sessionKind?: SessionKind;
  campaignId?: string;
}): React.JSX.Element {
  const [input, setInput] = useState('');
  const [allowWebSearch, setAllowWebSearch] = useState(true);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [history, setHistory] = useState<SessionMessageView[]>([]);
  const [showSidebar, setShowSidebar] = useState(true);

  const loadSessions = useCallback(() => {
    void invoke('session:list', { kind: sessionKind, limit: 40 }).then(setSessions);
  }, [sessionKind]);

  const handleDone = useCallback(
    (done: { sessionId: string | null; contentMd: string }) => {
      if (done.sessionId) {
        void invoke('session:getMessages', { sessionId: done.sessionId }).then(setHistory);
        loadSessions();
      }
    },
    [loadSessions],
  );

  const { state, send, cancel, reset, setSessionId } = useStream(null, handleDone);

  const loadHistory = useCallback(
    async (sessionId: string) => {
      const msgs = await invoke('session:getMessages', { sessionId });
      setHistory(msgs);
      setSessionId(sessionId);
      reset();
    },
    [reset, setSessionId],
  );

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const startNewSession = (): void => {
    setHistory([]);
    reset();
    setSessionId(null);
  };

  const submit = (): void => {
    const text = input.trim();
    if (!text || state.running) return;
    setInput('');
    const userMsg: SessionMessageView = {
      id: `pending-${Date.now()}`,
      sessionId: state.sessionId ?? '',
      role: 'user',
      contentMd: text,
      citations: [],
      createdAt: Date.now(),
    };
    setHistory((h) => {
      const next = [...h, userMsg];
      void send({
        role,
        allowWebSearch,
        sessionId: state.sessionId ?? undefined,
        campaignId,
        messages: [
          ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
          ...next
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map((m) => ({ role: m.role, content: m.contentMd })),
        ],
      });
      return next;
    });
  };

  return (
    <div className="flex h-full min-h-0 gap-3">
      {showSidebar && (
        <aside className="flex w-52 shrink-0 flex-col gap-2 border-r border-[var(--color-border)] pr-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--color-muted)]">历史会话</span>
            <button
              type="button"
              onClick={startNewSession}
              className="text-xs text-sky-400 hover:underline"
            >
              新对话
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
            {sessions.length === 0 ? (
              <p className="text-xs text-[var(--color-muted)]">暂无记录</p>
            ) : (
              sessions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => void loadHistory(s.id)}
                  className={`w-full rounded px-2 py-1.5 text-left text-xs ${
                    state.sessionId === s.id
                      ? 'bg-[var(--color-surface)] text-[var(--color-fg)]'
                      : 'text-[var(--color-muted)] hover:bg-black/20'
                  }`}
                >
                  <div className="truncate font-medium">{s.title}</div>
                  <div className="text-[10px] opacity-70">{s.messageCount} 条消息</div>
                </button>
              ))
            )}
          </div>
        </aside>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
          <button
            type="button"
            onClick={() => setShowSidebar((v) => !v)}
            className="hover:text-[var(--color-fg)]"
          >
            {showSidebar ? '隐藏历史' : '显示历史'}
          </button>
          {state.sessionId && <span>· 会话已保存</span>}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          {history.length > 0 || state.text || state.running ? (
            <div className="space-y-4">
              {history.map((m) => (
                <div
                  key={m.id}
                  className={`text-sm ${m.role === 'user' ? 'text-sky-200' : 'leading-relaxed'}`}
                >
                  <span className="mb-1 block text-[10px] uppercase text-[var(--color-muted)]">
                    {m.role === 'user' ? '你' : '助手'}
                  </span>
                  <div className="whitespace-pre-wrap">{m.contentMd}</div>
                  {m.citations.length > 0 && <CitationList citations={m.citations} />}
                </div>
              ))}
              {state.running && !state.text && (
                <p className="text-sm text-[var(--color-muted)]">生成中…</p>
              )}
              {(state.text || state.running) && (
                <div className="leading-relaxed">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-[10px] uppercase text-[var(--color-muted)]">助手</span>
                    <SourceBadge kind={state.evidenceKind} />
                    {state.running && (
                      <span className="text-xs text-[var(--color-muted)]">生成中…</span>
                    )}
                  </div>
                  <div className="whitespace-pre-wrap text-sm">{state.text}</div>
                  <ToolTrace calls={state.toolCalls} />
                  <CitationList citations={state.citations} />
                </div>
              )}
            </div>
          ) : state.error ? (
            <div className="rounded border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
              {state.error}
            </div>
          ) : (
            <p className="text-sm text-[var(--color-muted)]">
              开启联网后，Agent 会自行判断是否需要检索，回答会落库并可在左侧回看。
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={allowWebSearch}
              onChange={(e) => setAllowWebSearch(e.target.checked)}
            />
            允许联网检索
          </label>
          <span>·</span>
          <span>角色 {role}</span>
          {state.running ? (
            <button type="button" onClick={cancel} className="ml-auto hover:text-[var(--color-fg)]">
              取消
            </button>
          ) : (
            history.length > 0 && (
              <button
                type="button"
                onClick={startNewSession}
                className="ml-auto hover:text-[var(--color-fg)]"
              >
                清空
              </button>
            )
          )}
        </div>

        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
            }}
            placeholder={placeholder}
            rows={3}
            className="flex-1 resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm outline-none focus:border-[var(--color-accent)]"
          />
          <button
            type="button"
            onClick={submit}
            disabled={state.running || !input.trim()}
            className="self-end rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium disabled:opacity-40"
          >
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
