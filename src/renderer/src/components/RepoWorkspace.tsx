import { useState } from 'react';
import type { Repo } from '@shared/entities';
import { useStream } from '../ipc/useStream';
import { invoke } from '../ipc';
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
  const { state, send, cancel, reset } = useStream();
  const [input, setInput] = useState('');
  const [allowWebSearch, setAllowWebSearch] = useState(true);
  const [codeLoc, setCodeLoc] = useState<CodeLocation | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const submit = (): void => {
    const text = input.trim();
    if (!text || state.running || repo.status !== 'ready') return;
    setInput('');
    setSaved(false);
    void send({
      role: 'codeAgent',
      repoId: repo.id,
      allowWebSearch,
      messages: [{ role: 'user', content: text }],
    });
  };

  const saveSpeech = async (): Promise<void> => {
    if (!state.text.trim()) return;
    setSaving(true);
    try {
      await invoke('speech:save', { repoId: repo.id, contentMd: state.text, tier: 'spoken' });
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  const openCitation = (filePath?: string, startLine?: number, endLine?: number): void => {
    if (!filePath || !startLine) return;
    setCodeLoc({ filePath, startLine, endLine });
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 lg:flex-row">
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          {repo.status !== 'ready' ? (
            <p className="text-sm text-[var(--color-muted)]">仓库索引中，完成后可开始问答…</p>
          ) : state.error ? (
            <div className="rounded border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
              {state.error}
            </div>
          ) : state.text || state.running ? (
            <>
              <div className="mb-2 flex items-center gap-2">
                <SourceBadge kind={state.evidenceKind} />
                {state.running && (
                  <span className="text-xs text-[var(--color-muted)]">分析中…</span>
                )}
              </div>
              <MarkdownContent text={state.text} onCodeClick={setCodeLoc} />
              <ToolTrace calls={state.toolCalls} />
              <CitationList
                citations={state.citations}
                onCodeClick={(c) => openCitation(c.filePath, c.startLine, c.endLine)}
              />
            </>
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
              {state.text && (
                <>
                  <button
                    type="button"
                    onClick={() => void saveSpeech()}
                    disabled={saving}
                    className="hover:text-[var(--color-fg)] disabled:opacity-40"
                  >
                    {saved ? '已存入话术库' : saving ? '保存中…' : '存入话术库'}
                  </button>
                  <button type="button" onClick={reset} className="hover:text-[var(--color-fg)]">
                    清空
                  </button>
                </>
              )}
              {onComplete && (
                <button
                  type="button"
                  onClick={onComplete}
                  className="ml-auto rounded bg-[var(--color-accent)] px-2 py-1 text-[var(--color-fg)]"
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
            className="self-end rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium disabled:opacity-40"
          >
            发送
          </button>
        </div>
      </div>

      <div className="h-64 shrink-0 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] lg:h-auto lg:w-96">
        <CodePanel repoId={repo.id} location={codeLoc} />
      </div>
    </div>
  );
}
