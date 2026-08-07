import { useState } from 'react';
import type { StreamToolCall } from '@shared/ipc';

/**
 * 推理过程面板。目的不是 debug，而是建立信任——
 * 让用户能看到 Agent 到底搜了什么、读了哪些内容，从而判断答案是否可信。
 */
export function ToolTrace({ calls }: { calls: StreamToolCall[] }): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (calls.length === 0) return null;

  return (
    <div className="mt-3 rounded-md border border-[var(--color-border)] bg-black/20 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[var(--color-muted)] hover:text-[var(--color-fg)]"
      >
        <span className={`transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
        推理过程 · {calls.length} 次工具调用
      </button>

      {open && (
        <ul className="space-y-2 border-t border-[var(--color-border)] px-3 py-2">
          {calls.map((c, i) => (
            <li key={i} className="space-y-1">
              <div className="flex items-center gap-2">
                <code className="rounded bg-[var(--color-surface)] px-1.5 py-0.5 text-sky-300">
                  {c.toolName}
                </code>
                <span className="text-[var(--color-muted)]">{c.durationMs}ms</span>
              </div>
              <div className="text-[var(--color-muted)]">{c.resultSummary}</div>
              <pre className="overflow-x-auto rounded bg-black/30 p-2 text-[11px] text-[var(--color-muted)]">
                {JSON.stringify(c.args)}
              </pre>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
