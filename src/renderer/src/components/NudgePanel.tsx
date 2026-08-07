import type { Nudge, NudgeKind } from '@shared/ipc';

const KIND_LABEL: Record<NudgeKind, string> = {
  blindSpot: '盲区',
  repeatedMiss: '反复答错',
  unpreparedLandmine: '雷区',
  stalledTask: '拖延',
  askedOften: '反复追问',
};

const SEVERITY_STYLE: Record<Nudge['severity'], string> = {
  high: 'border-red-900/50 bg-red-950/20 text-red-200',
  medium: 'border-amber-900/50 bg-amber-950/20 text-amber-100',
  low: 'border-[var(--color-border)] bg-black/20 text-[var(--color-muted)]',
};

/**
 * 主动提示面板。
 *
 * 「一直没被翻到的盲区」正是最该被提醒的东西——等用户自己想起来就晚了。
 */
export function NudgePanel({
  nudges,
  applying,
  onApplyHistory,
  onOpenNode,
}: {
  nudges: Nudge[];
  applying?: boolean;
  onApplyHistory?: () => void;
  onOpenNode?: (nodeId: string) => void;
}): React.JSX.Element {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-[var(--color-muted)]">
          {nudges.length > 0 ? `${nudges.length} 条待处理` : '暂时没有需要提醒的'}
        </p>
        {onApplyHistory && (
          <button
            type="button"
            disabled={applying}
            onClick={onApplyHistory}
            className="rounded border border-[var(--color-border)] px-2 py-0.5 text-xs disabled:opacity-40"
            title="把反复提问、反复答错、长期拖延回写成排序依据"
          >
            {applying ? '分析中…' : '应用历史信号'}
          </button>
        )}
      </div>

      {nudges.length > 0 && (
        <ul className="space-y-2">
          {nudges.map((n, i) => (
            <li
              key={`${n.kind}-${n.nodeId ?? i}`}
              className={`rounded-md border px-3 py-2 ${SEVERITY_STYLE[n.severity]}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-medium">
                    <span className="mr-1 opacity-70">[{KIND_LABEL[n.kind]}]</span>
                    {n.title}
                  </p>
                  <p className="mt-0.5 text-[10px] opacity-80">{n.detail}</p>
                </div>
                {n.nodeId && onOpenNode && (
                  <button
                    type="button"
                    onClick={() => onOpenNode(n.nodeId!)}
                    className="shrink-0 text-[10px] underline opacity-80 hover:opacity-100"
                  >
                    去学
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
