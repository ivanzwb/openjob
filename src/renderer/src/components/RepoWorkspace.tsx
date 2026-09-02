import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Repo } from '@shared/entities';
import type { AnnotationView, SessionMessageView, StreamDone } from '@shared/ipc';
import { normalizeDisplayText } from '@shared/lib/markdownDisplay';
import { useStream } from '../ipc/useStream';
import { invoke } from '../ipc';
import { runTask, useTask, useTaskResult } from '../ipc/taskStore';
import { ChatBubble } from './ChatBubble';
import { CodePanel } from './CodePanel';
import type { CodeLocation } from './MarkdownContent';
import { MarkdownContent } from './MarkdownContent';
import { CitationList, SourceBadge } from './SourceBadge';
import { ToolTrace } from './ToolTrace';

export function RepoWorkspace({
  repo,
  onComplete,
}: {
  repo: Repo;
  onComplete?: () => void;
}): React.JSX.Element {
  const [input, setInput] = useState('');
  const [allowWebSearch, setAllowWebSearch] = useState(true);
  const [codeLoc, setCodeLoc] = useState<CodeLocation | null>(null);
  const [saved, setSaved] = useState(false);

  // 离开「问答」页签会卸载这里，存话术的状态因此放到全局任务仓库
  const saveSpeechKey = `repo:saveSpeech:${repo.id}`;
  const { running: saving, error: saveError } = useTask(saveSpeechKey);
  useTaskResult(saveSpeechKey, () => setSaved(true));
  const [history, setHistory] = useState<SessionMessageView[]>([]);
  const [codeMarks, setCodeMarks] = useState<AnnotationView[]>([]);
  const sessionStorageKey = `openjob:repoQaSession:${repo.id}`;
  const initialSessionId = useMemo(
    () => window.localStorage.getItem(sessionStorageKey),
    [sessionStorageKey],
  );

  const loadCodeMarks = useCallback(() => {
    void invoke('annotation:listForRepo', { repoId: repo.id }).then(setCodeMarks);
  }, [repo.id]);

  useEffect(loadCodeMarks, [loadCodeMarks]);

  const fetchHistory = useCallback(
    (sessionId: string) => invoke('session:getMessages', { sessionId }),
    [],
  );

  const handleDone = useCallback(
    (done: StreamDone): void => {
      if (!done.sessionId) return;
      // 主进程已经把最终回答、引用和工具记录作为一个事务序列落库。
      // 回读数据库而不是手拼一条消息，避免实时态与历史态字段不一致。
      void fetchHistory(done.sessionId)
        .then(setHistory)
        .catch(() => {
          if (!done.contentMd.trim()) return;
          setHistory((current) => [
            ...current,
            {
              id: `completed-${Date.now()}`,
              sessionId: done.sessionId!,
              role: 'assistant',
              contentMd: done.contentMd,
              citations: done.citations,
              createdAt: Date.now(),
              usage: done.usage,
              evidenceKind: done.evidenceKind,
              toolCalls: [],
            },
          ]);
        });
    },
    [fetchHistory],
  );

  const { state, send, cancel, reset, setSessionId } = useStream(
    `repoQa:${repo.id}`,
    initialSessionId,
    handleDone,
  );

  useEffect(() => {
    if (state.sessionId) window.localStorage.setItem(sessionStorageKey, state.sessionId);
    else window.localStorage.removeItem(sessionStorageKey);
  }, [sessionStorageKey, state.sessionId]);

  useEffect(() => {
    const sessionId = state.sessionId;
    if (!sessionId || history.length > 0) return;
    void fetchHistory(sessionId)
      .then(setHistory)
      .catch(() => {
        // 会话可能已在另一台设备删除；清掉失效指针，下一问会新建会话。
        reset();
        setSessionId(null);
      });
  }, [fetchHistory, history.length, reset, setSessionId, state.sessionId]);

  const submit = (): void => {
    const text = input.trim();
    if (!text || state.running || repo.status !== 'ready') return;
    setInput('');
    setSaved(false);
    const userMessage: SessionMessageView = {
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
    const next = [...history, userMessage];
    setHistory(next);
    void send({
      role: 'codeAgent',
      repoId: repo.id,
      allowWebSearch,
      sessionKind: 'repoQa',
      sessionId: state.sessionId ?? undefined,
      messages: next.map((message) => ({
        role: message.role,
        content: message.contentMd,
      })),
    });
  };

  const latestAnswer =
    [...history].reverse().find((message) => message.role === 'assistant')?.contentMd ??
    state.text;

  const saveSpeech = (): void => {
    if (!latestAnswer.trim()) return;
    const contentMd = latestAnswer;
    void runTask(saveSpeechKey, () =>
      invoke('speech:save', { repoId: repo.id, contentMd, tier: 'spoken' }),
    ).catch(() => undefined);
  };

  const clearConversation = (): void => {
    const sessionId = state.sessionId;
    setHistory([]);
    reset();
    setSessionId(null);
    window.localStorage.removeItem(sessionStorageKey);
    if (sessionId) void invoke('session:delete', { sessionId });
  };

  const openCitation = (filePath?: string, startLine?: number, endLine?: number): void => {
    if (!filePath || !startLine) return;
    setCodeLoc({ filePath, startLine, endLine });
  };

  /** 标记列表里的 label 形如 path/to/file.go:120 */
  const openMark = (label: string): void => {
    const at = label.lastIndexOf(':');
    const line = Number(label.slice(at + 1));
    if (at < 0 || !Number.isFinite(line)) return;
    setCodeLoc({ filePath: label.slice(0, at), startLine: line });
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 lg:flex-row">
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          {repo.status !== 'ready' ? (
            <p className="text-sm text-[var(--color-muted)]">仓库索引中，完成后可开始问答…</p>
          ) : history.length > 0 || state.running ? (
            <div className="space-y-4">
              {history.map((message) => (
                <ChatBubble
                  key={message.id}
                  role={message.role === 'user' ? 'user' : 'assistant'}
                >
                  <div className="mb-1 flex items-center gap-2">
                    <span className="text-[10px] uppercase text-[var(--color-muted)]">
                      {message.role === 'user' ? '你' : '助手'}
                    </span>
                    {message.role === 'assistant' && message.evidenceKind && (
                      <SourceBadge kind={message.evidenceKind} />
                    )}
                  </div>
                  {message.role === 'user' ? (
                    <div className="whitespace-pre-wrap">{message.contentMd}</div>
                  ) : (
                    <MarkdownContent
                      text={normalizeDisplayText(message.contentMd)}
                      onCodeClick={setCodeLoc}
                    />
                  )}
                  {message.role === 'assistant' && (
                    <>
                      <ToolTrace calls={message.toolCalls} usage={message.usage} />
                      <CitationList
                        citations={message.citations}
                        onCodeClick={(citation) =>
                          openCitation(
                            citation.filePath,
                            citation.startLine,
                            citation.endLine,
                          )
                        }
                      />
                    </>
                  )}
                </ChatBubble>
              ))}
              {state.running && (
                <ChatBubble role="assistant">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-[10px] uppercase text-[var(--color-muted)]">助手</span>
                    <SourceBadge kind={state.evidenceKind} />
                    <span className="text-xs text-[var(--color-muted)]">
                      {state.text ? '正在组织回答…' : '正在检索并阅读代码…'}
                    </span>
                  </div>
                  {state.text && (
                    <MarkdownContent
                      text={normalizeDisplayText(state.text)}
                      onCodeClick={setCodeLoc}
                    />
                  )}
                  <ToolTrace calls={state.toolCalls} usage={state.usage} />
                  <CitationList
                    citations={state.citations}
                    onCodeClick={(citation) =>
                      openCitation(citation.filePath, citation.startLine, citation.endLine)
                    }
                  />
                </ChatBubble>
              )}
              {state.error && (
                <div className="rounded border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
                  {state.error}
                </div>
              )}
            </div>
          ) : state.error ? (
            <div className="rounded border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
              {state.error}
            </div>
          ) : (
            <p className="text-sm text-[var(--color-muted)]">
              问启动流程、核心模块、关键数据结构… 回答会带 path:line 引用，流程可用 mermaid 图展示。
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted)]">
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={allowWebSearch}
              onChange={(e) => setAllowWebSearch(e.target.checked)}
            />
            允许联网（查设计意图）
          </label>
          {state.running ? (
            <button type="button" onClick={cancel} className="ml-auto hover:text-[var(--color-fg)]">
              取消
            </button>
          ) : (
            <>
              {latestAnswer && (
                <>
                  <button
                    type="button"
                    onClick={saveSpeech}
                    disabled={saving}
                    className="hover:text-[var(--color-fg)] disabled:opacity-40"
                  >
                    {saved ? '已存入话术库' : saving ? '保存中…' : '存入话术库'}
                  </button>
                  {saveError && <span className="text-red-400">{saveError}</span>}
                  <button
                    type="button"
                    onClick={clearConversation}
                    className="hover:text-[var(--color-fg)]"
                  >
                    清空
                  </button>
                </>
              )}
              {onComplete && (
                <button
                  type="button"
                  onClick={onComplete}
                  className="ml-auto rounded bg-[var(--color-accent)] px-2 py-1 text-white"
                >
                  标记任务完成
                </button>
              )}
            </>
          )}
        </div>

        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
            }}
            placeholder="例如：主流程是怎么启动的？关键配置在哪？"
            rows={2}
            disabled={repo.status !== 'ready'}
            className="flex-1 resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
          />
          <button
            type="button"
            onClick={submit}
            disabled={state.running || !input.trim() || repo.status !== 'ready'}
            className="self-end rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            发送
          </button>
        </div>
      </div>

      <div className="flex shrink-0 flex-col gap-3 lg:w-[min(32rem,32%)] lg:min-w-[18rem]">
        <div className="h-64 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] lg:h-auto lg:flex-1">
          <CodePanel repoId={repo.id} location={codeLoc} onAnnotationChange={loadCodeMarks} />
        </div>

        {codeMarks.length > 0 && (
          <div className="max-h-56 shrink-0 space-y-2 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
            <h4 className="text-xs font-medium text-[var(--color-muted)]">
              代码标记（{codeMarks.length}）
            </h4>
            <ul className="space-y-1 text-xs">
              {codeMarks.map((m) => (
                <li key={m.id} className="space-y-0.5">
                  <button
                    type="button"
                    onClick={() => openMark(m.targetLabel)}
                    className="font-mono text-emerald-400 hover:underline"
                  >
                    {m.targetLabel}
                  </button>
                  {m.kind !== 'bookmark' && (
                    <div className="break-words text-[var(--color-muted)]">
                      {m.kind === 'highlight' ? `「${m.selectedText}」` : m.noteMd}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
