import { useState } from 'react';
import type { LlmRole } from '@shared/enums';
import { useStream } from '../ipc/useStream';
import { CitationList, SourceBadge } from './SourceBadge';
import { ToolTrace } from './ToolTrace';

/**
 * 流式对话组件。阶段 2 的「考我」与阶段 3 的源码问答都复用它——
 * 这也是把两条链路做进同一个 MVP 仍然可行的原因之一。
 */
export function StreamChat({
  role = 'explain',
  systemPrompt,
  placeholder = '问点什么…',
}: {
  role?: LlmRole;
  systemPrompt?: string;
  placeholder?: string;
}): React.JSX.Element {
  const { state, send, cancel, reset } = useStream();
  const [input, setInput] = useState('');
  const [allowWebSearch, setAllowWebSearch] = useState(true);

  const submit = (): void => {
    const text = input.trim();
    if (!text || state.running) return;
    setInput('');
    void send({
      role,
      allowWebSearch,
      messages: [
        ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
        { role: 'user' as const, content: text },
      ],
    });
  };

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        {state.error ? (
          <div className="rounded border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
            {state.error}
          </div>
        ) : state.text || state.running ? (
          <>
            <div className="mb-2 flex items-center gap-2">
              <SourceBadge kind={state.evidenceKind} />
              {state.running && (
                <span className="text-xs text-[var(--color-muted)]">生成中…</span>
              )}
            </div>
            <div className="whitespace-pre-wrap text-sm leading-relaxed">{state.text}</div>
            <ToolTrace calls={state.toolCalls} />
            <CitationList citations={state.citations} />
          </>
        ) : (
          <p className="text-sm text-[var(--color-muted)]">
            阶段 0 验收用的对话面板。开启联网后，Agent 会自行判断是否需要检索，
            回答下方会列出出处。
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
          state.text && (
            <button type="button" onClick={reset} className="ml-auto hover:text-[var(--color-fg)]">
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
  );
}
