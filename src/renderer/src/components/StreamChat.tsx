import { useCallback, useEffect, useState } from 'react';
import type { LlmRole, SessionKind } from '@shared/enums';
import type { SessionMessageView, SessionSearchHit, SessionSummary } from '@shared/ipc';
import { normalizeDisplayText } from '@shared/lib/markdownDisplay';
import { useStream } from '../ipc/useStream';
import { invoke } from '../ipc';
import { useDataRefresh } from '../ipc/dataVersion';
import { MarkdownContent } from './MarkdownContent';
import { CitationList, SourceBadge } from './SourceBadge';
import { ToolTrace } from './ToolTrace';
import { useToast } from './Toast';
import { VoiceInputButton } from './VoiceInputButton';

/**
 * 消息气泡。两边都靠左、只靠一个小标签区分角色时，滚动起来根本认不出谁说的哪句，
 * 所以用户靠右、助手靠左，各自带底色。助手不限宽——它的正文里有代码块、表格和
 * 流程图，压进窄气泡会横向溢出。
 */
function ChatBubble({
  role,
  children,
}: {
  role: 'user' | 'assistant';
  children: React.ReactNode;
}): React.JSX.Element {
  const isUser = role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={
          isUser
            ? 'max-w-[85%] rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm text-sky-100'
            : 'w-full rounded-lg border border-[var(--color-border)] bg-black/20 px-3 py-2 text-sm leading-relaxed'
        }
      >
        {children}
      </div>
    </div>
  );
}

/**
 * 流式对话组件，支持会话历史落库与回看。
 */
export function StreamChat({
  streamKey,
  role = 'explain',
  systemPrompt,
  placeholder = '问点什么…',
  sessionKind = 'freeChat',
  campaignId,
  nodeId,
  compact = false,
  allowWebSearch: allowWebSearchDefault = true,
  allowTools = true,
  sessionStorageKey,
  showSessionHistory = true,
}: {
  /** 这一路流的稳定标识：面板被卸载后按它接回，生成中的回答不会丢 */
  streamKey: string;
  role?: LlmRole;
  systemPrompt?: string;
  placeholder?: string;
  sessionKind?: SessionKind;
  campaignId?: string;
  /** 会话所属知识点；用于追问历史跨端同步与恢复 */
  nodeId?: string;
  /** 嵌入备考/总览时使用：默认隐藏历史侧栏、精简控件 */
  compact?: boolean;
  allowWebSearch?: boolean;
  allowTools?: boolean;
  /** 保存当前会话 ID；适合按知识点恢复各自的对话 */
  sessionStorageKey?: string;
  /** 是否显示跨会话历史侧栏 */
  showSessionHistory?: boolean;
}): React.JSX.Element {
  const toast = useToast();
  const [input, setInput] = useState('');
  const [allowWebSearch, setAllowWebSearch] = useState(allowWebSearchDefault);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [history, setHistory] = useState<SessionMessageView[]>([]);
  const [showSidebar, setShowSidebar] = useState(!compact);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SessionSearchHit[] | null>(null);
  const [initialSessionId] = useState<string | null>(() =>
    sessionStorageKey ? window.localStorage.getItem(sessionStorageKey) : null,
  );

  const loadSessions = useCallback(() => {
    void invoke('session:list', { kind: sessionKind, nodeId, limit: 40 }).then(setSessions);
  }, [nodeId, sessionKind]);

  const fetchHistory = useCallback(
    (sessionId: string) =>
      nodeId
        ? invoke('session:getMessagesForNode', { nodeId })
        : invoke('session:getMessages', { sessionId }),
    [nodeId],
  );

  // 搜索跨 kind，因为「我之前在哪问过这个」时用户并不记得当时在哪个页面问的
  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const timer = setTimeout(() => {
      void invoke('session:search', { query: q, limit: 30 }).then(setHits);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  // 清空输入时直接回落到会话列表，不必再触发一次 setState
  const searchHits = query.trim() ? hits : null;

  const handleDone = useCallback(
    (done: { sessionId: string | null; contentMd: string }) => {
      if (done.contentMd.trim()) {
        setHistory((h) => {
          const last = h[h.length - 1];
          if (last?.role === 'assistant' && last.contentMd === done.contentMd) return h;
          return [
            ...h,
            {
              id: `assistant-${Date.now()}`,
              sessionId: done.sessionId ?? '',
              role: 'assistant' as const,
              contentMd: done.contentMd,
              citations: [],
              createdAt: Date.now(),
              usage: null,
              evidenceKind: null,
              toolCalls: [],
            },
          ];
        });
      }
      if (done.sessionId) {
        void fetchHistory(done.sessionId).then(setHistory);
        loadSessions();
      }
    },
    [fetchHistory, loadSessions],
  );

  const { state, send, cancel, reset, setSessionId } = useStream(
    streamKey,
    initialSessionId,
    handleDone,
  );

  useEffect(() => {
    if (!sessionStorageKey) return;
    if (state.sessionId) window.localStorage.setItem(sessionStorageKey, state.sessionId);
    else window.localStorage.removeItem(sessionStorageKey);
  }, [sessionStorageKey, state.sessionId]);

  // 上一次的回答还留在流里（比如生成时切走过），把这一会话的消息补回来
  useEffect(() => {
    const sessionId = state.sessionId;
    if (!sessionId || history.length > 0) return;
    void fetchHistory(sessionId).then(setHistory);
  }, [fetchHistory, state.sessionId, history.length]);

  const loadHistory = useCallback(
    async (sessionId: string) => {
      const msgs = await fetchHistory(sessionId);
      setHistory(msgs);
      reset();
      setSessionId(sessionId);
    },
    [fetchHistory, reset, setSessionId],
  );

  useDataRefresh(() => {
    if (!nodeId) return;
    void invoke('session:list', { kind: sessionKind, nodeId, limit: 40 }).then((syncedSessions) => {
      setSessions(syncedSessions);
      const currentSessionId = state.sessionId;
      if (!currentSessionId) return;
      if (!syncedSessions.some((session) => session.id === currentSessionId)) {
        setHistory([]);
        reset();
        setSessionId(null);
        if (sessionStorageKey) window.localStorage.removeItem(sessionStorageKey);
        return;
      }
      void fetchHistory(currentSessionId).then(setHistory);
    });
  });

  useEffect(() => {
    if (!showSessionHistory && !nodeId) return;
    loadSessions();
  }, [loadSessions, nodeId, showSessionHistory]);

  // 升级前桌面用 localStorage 绑定知识点；首次打开时补写 node_id，使旧历史进入同步。
  useEffect(() => {
    if (!nodeId || !initialSessionId) return;
    void invoke('session:bindNode', {
      sessionId: initialSessionId,
      nodeId,
      campaignId,
    }).then(loadSessions);
  }, [campaignId, initialSessionId, loadSessions, nodeId]);

  // 新设备没有 localStorage，从已同步的知识点会话中恢复最近一次历史。
  useEffect(() => {
    if (!nodeId || state.sessionId || history.length > 0 || sessions.length === 0) return;
    const timer = window.setTimeout(() => void loadHistory(sessions[0].id), 0);
    return () => window.clearTimeout(timer);
  }, [history.length, loadHistory, nodeId, sessions, state.sessionId]);

  const startNewSession = (): void => {
    setHistory([]);
    reset();
    setSessionId(null);
  };

  const removeSession = async (sessionId: string): Promise<void> => {
    await invoke('session:delete', { sessionId });
    if (state.sessionId === sessionId) startNewSession();
    loadSessions();
  };

  const clearCurrentHistory = async (): Promise<void> => {
    const currentSessionId = state.sessionId;
    if (nodeId) setSessions([]);
    setHistory([]);
    reset();
    setSessionId(null);
    if (sessionStorageKey) window.localStorage.removeItem(sessionStorageKey);
    if (nodeId) {
      await invoke('session:deleteForNode', { nodeId });
    } else if (currentSessionId) {
      await invoke('session:delete', { sessionId: currentSessionId });
    }
    if (showSessionHistory) loadSessions();
  };

  // 追问里的回答常常就是能直接背的话术，允许整条存进话术库
  const saveMessageToSpeech = (contentMd: string): void => {
    const text = contentMd.trim();
    if (!nodeId || !text) return;
    void invoke('speech:saveFromNode', { nodeId, contentMd: text, tier: 'spoken' })
      .then(() => toast('已加入话术库', { variant: 'success' }))
      .catch((e: unknown) =>
        toast(e instanceof Error ? e.message : '加入话术库失败', { variant: 'error' }),
      );
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
      usage: null,
      evidenceKind: null,
      toolCalls: [],
    };
    setHistory((h) => {
      const next = [...h, userMsg];
      void send({
        role,
        allowWebSearch: allowTools ? allowWebSearch : false,
        allowTools,
        sessionKind,
        sessionId: state.sessionId ?? undefined,
        campaignId,
        nodeId,
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
      {showSessionHistory && showSidebar && (
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
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索历史对话…"
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs"
          />
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
            {searchHits !== null ? (
              searchHits.length === 0 ? (
                <p className="text-xs text-[var(--color-muted)]">没有匹配的对话</p>
              ) : (
                searchHits.map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    onClick={() => void loadHistory(h.id)}
                    className="w-full rounded px-2 py-1.5 text-left text-xs text-[var(--color-muted)] hover:bg-black/20"
                  >
                    <div className="truncate font-medium text-[var(--color-fg)]">{h.title}</div>
                    <div className="line-clamp-2 text-[10px] opacity-80">{h.snippet}</div>
                    <div className="text-[10px] opacity-60">命中 {h.matchCount} 条</div>
                  </button>
                ))
              )
            ) : sessions.length === 0 ? (
              <p className="text-xs text-[var(--color-muted)]">暂无记录</p>
            ) : (
              sessions.map((s) => (
                <div
                  key={s.id}
                  className={`group flex items-start gap-1 rounded ${
                    state.sessionId === s.id
                      ? 'bg-[var(--color-surface)]'
                      : 'hover:bg-black/20'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => void loadHistory(s.id)}
                    className={`min-w-0 flex-1 px-2 py-1.5 text-left text-xs ${
                      state.sessionId === s.id
                        ? 'text-[var(--color-fg)]'
                        : 'text-[var(--color-muted)]'
                    }`}
                  >
                    <div className="truncate font-medium">{s.title}</div>
                    <div className="text-[10px] opacity-70">
                      {s.messageCount} 条消息
                      {s.totalTokens > 0 && ` · ${(s.totalTokens / 1000).toFixed(1)}k tokens`}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => void removeSession(s.id)}
                    className="px-1 py-1.5 text-[10px] text-[var(--color-muted)] opacity-0 hover:text-red-400 group-hover:opacity-100"
                    title="删除会话"
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>
        </aside>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
          {showSessionHistory && !compact && (
            <button
              type="button"
              onClick={() => setShowSidebar((v) => !v)}
              className="hover:text-[var(--color-fg)]"
            >
              {showSidebar ? '隐藏历史' : '显示历史'}
            </button>
          )}
          {showSessionHistory && compact && (
            <button
              type="button"
              onClick={() => setShowSidebar((v) => !v)}
              className="hover:text-[var(--color-fg)]"
            >
              {showSidebar ? '收起历史' : '历史'}
            </button>
          )}
          {state.sessionId && <span>· 会话已保存</span>}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          {history.length > 0 || state.text || state.running ? (
            <div className="space-y-4">
              {history.map((m) => (
                <ChatBubble key={m.id} role={m.role === 'user' ? 'user' : 'assistant'}>
                  <div className="mb-1 flex items-center gap-2">
                    <span className="text-[10px] uppercase text-[var(--color-muted)]">
                      {m.role === 'user' ? '你' : '助手'}
                    </span>
                    {m.role === 'assistant' && m.evidenceKind && (
                      <SourceBadge kind={m.evidenceKind} />
                    )}
                  </div>
                  {m.role === 'user' ? (
                    <div className="whitespace-pre-wrap">{m.contentMd}</div>
                  ) : (
                    <MarkdownContent text={normalizeDisplayText(m.contentMd)} />
                  )}
                  {m.role === 'assistant' && nodeId && m.contentMd.trim() && (
                    <button
                      type="button"
                      onClick={() => saveMessageToSpeech(m.contentMd)}
                      className="mt-1 text-[10px] text-sky-400 hover:underline"
                    >
                      加入话术库
                    </button>
                  )}
                  <ToolTrace calls={m.toolCalls} usage={m.usage} />
                  {m.citations.length > 0 && <CitationList citations={m.citations} />}
                </ChatBubble>
              ))}
              {state.running && !state.text && (
                <p className="text-sm text-[var(--color-muted)]">生成中…</p>
              )}
              {state.running && (
                <ChatBubble role="assistant">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-[10px] uppercase text-[var(--color-muted)]">助手</span>
                    <SourceBadge kind={state.evidenceKind} />
                    <span className="text-xs text-[var(--color-muted)]">生成中…</span>
                  </div>
                  {state.text ? <MarkdownContent text={normalizeDisplayText(state.text)} /> : null}
                  <ToolTrace calls={state.toolCalls} usage={state.usage} />
                  <CitationList citations={state.citations} />
                </ChatBubble>
              )}
            </div>
          ) : state.error ? (
            <div className="rounded border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
              {state.error}
            </div>
          ) : (
            <p className="text-sm text-[var(--color-muted)]">
              {compact
                ? allowTools
                  ? '可联网检索；回答会保存，需要时展开历史回看。'
                  : '围绕当前考点多轮追问，回答会保存，需要时展开历史回看。'
                : '开启联网后，Agent 会自行判断是否需要检索，回答会落库并可在左侧回看。'}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
          {allowTools && (
            <label className="flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={allowWebSearch}
                onChange={(e) => setAllowWebSearch(e.target.checked)}
              />
              允许联网检索
            </label>
          )}
          {allowTools && <span>·</span>}
          {!compact && (
            <>
              <span>角色 {role}</span>
            </>
          )}
          {state.running ? (
            <button type="button" onClick={cancel} className="ml-auto hover:text-[var(--color-fg)]">
              取消
            </button>
          ) : (
            history.length > 0 && (
              <button
                type="button"
                onClick={() => void (sessionStorageKey ? clearCurrentHistory() : startNewSession())}
                className="ml-auto hover:text-[var(--color-fg)]"
              >
                {sessionStorageKey ? '清除历史' : '清空'}
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
            rows={compact ? 2 : 3}
            className="flex-1 resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm outline-none focus:border-[var(--color-accent)]"
          />
          <div className="flex flex-col items-end justify-end gap-2">
            <VoiceInputButton currentText={input} onTextChange={setInput} />
            <button
              type="button"
              onClick={submit}
              disabled={state.running || !input.trim()}
              className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              发送
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
