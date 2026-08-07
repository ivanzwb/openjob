import { useState } from 'react';
import type { StreamToolCall, ToolCallView } from '@shared/ipc';

/** 实时流用 StreamToolCall，回看历史用 ToolCallView，后者多了摊到的 token */
type TraceEntry = StreamToolCall | ToolCallView;

function tokenCostOf(call: TraceEntry): number | null {
  return 'tokenCost' in call ? call.tokenCost : null;
}

/**
 * 推理过程面板。目的不是 debug，而是建立信任——
 * 让用户能看到 Agent 到底搜了什么、读了哪些内容，从而判断答案是否可信。
 *
 * 同时也是成本的落点：每个工具往上下文里塞了多少 token 直接标在这里，
 * 「真正贵的是抓回来的正文而不是搜索调用本身」这件事得能被看见。
 */
export function ToolTrace({
  calls,
  usage,
}: {
  calls: TraceEntry[];
  usage?: { promptTokens: number; completionTokens: number } | null;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (calls.length === 0) return null;

  const total = (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0);

  return (
    <div className="mt-3 rounded-md border border-[var(--color-border)] bg-black/20 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[var(--color-muted)] hover:text-[var(--color-fg)]"
      >
        <span className={`transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
        推理过程 · {calls.length} 次工具调用
        {total > 0 && <span className="ml-auto">{total.toLocaleString()} tokens</span>}
      </button>

      {open && (
        <ul className="space-y-2 border-t border-[var(--color-border)] px-3 py-2">
          {usage && (
            <li className="text-[var(--color-muted)]">
              输入 {usage.promptTokens.toLocaleString()} · 输出{' '}
              {usage.completionTokens.toLocaleString()}
            </li>
          )}
          {calls.map((c, i) => {
            const cost = tokenCostOf(c);
            return (
              <li key={i} className="space-y-1">
                <div className="flex items-center gap-2">
                  <code className="rounded bg-[var(--color-surface)] px-1.5 py-0.5 text-sky-300">
                    {c.toolName}
                  </code>
                  <span className="text-[var(--color-muted)]">{c.durationMs}ms</span>
                  {cost !== null && (
                    <span
                      className="text-[var(--color-muted)]"
                      title="该工具的结果进入上下文所占的 token"
                    >
                      ~{cost.toLocaleString()} tokens
                    </span>
                  )}
                </div>
                <div className="text-[var(--color-muted)]">{c.resultSummary}</div>
                <pre className="overflow-x-auto rounded bg-black/30 p-2 text-[11px] text-[var(--color-muted)]">
                  {JSON.stringify(c.args)}
                </pre>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
