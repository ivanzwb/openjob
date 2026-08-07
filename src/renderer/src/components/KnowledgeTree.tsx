import type { KnowledgeNodeView } from '@shared/ipc';
import type { NodeKind } from '@shared/enums';
import { CoverageBadge } from './CoverageBadge';

const KIND_LABEL: Record<NodeKind, string> = {
  domain: '领域',
  topic: '主题',
  point: '知识点',
};

interface TreeProps {
  nodes: KnowledgeNodeView[];
  onExpand?: (nodeId: string) => void;
  onDelete?: (nodeId: string) => void;
  expandingId?: string | null;
}

/** 层级考点清单 + 进度条，不做图谱可视化 */
export function KnowledgeTree({
  nodes,
  onExpand,
  onDelete,
  expandingId,
}: TreeProps): React.JSX.Element {
  const roots = nodes.filter((n) => !n.parentId);
  const byParent = new Map<string | null, KnowledgeNodeView[]>();
  for (const n of nodes) {
    const key = n.parentId;
    const list = byParent.get(key) ?? [];
    list.push(n);
    byParent.set(key, list);
  }

  const renderNode = (node: KnowledgeNodeView, depth: number): React.JSX.Element => {
    const children = byParent.get(node.id) ?? [];
    const masteryPct = Math.round((node.mastery / 5) * 100);

    return (
      <div key={node.id}>
        <div
          className="flex items-start gap-2 rounded-md border border-transparent px-2 py-2 hover:border-[var(--color-border)] hover:bg-black/20"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{node.name}</span>
              <span className="text-[10px] text-[var(--color-muted)]">
                {KIND_LABEL[node.kind]}
              </span>
              <CoverageBadge type={node.coverageType} />
            </div>
            <p className="mt-1 text-xs text-[var(--color-muted)]">{node.priorityReason}</p>
            <div className="mt-2 flex items-center gap-2">
              <div className="h-1.5 flex-1 max-w-[120px] rounded-full bg-[var(--color-border)]">
                <div
                  className="h-full rounded-full bg-[var(--color-accent)]"
                  style={{ width: `${masteryPct}%` }}
                />
              </div>
              <span className="text-[10px] text-[var(--color-muted)]">
                掌握 {node.mastery}/5 · {node.estMinutes}min
              </span>
            </div>
          </div>
          <div className="flex shrink-0 gap-1">
            {(node.kind === 'domain' || node.kind === 'topic') && onExpand && (
              <button
                type="button"
                disabled={expandingId === node.id}
                onClick={() => onExpand(node.id)}
                className="rounded border border-[var(--color-border)] px-2 py-0.5 text-xs disabled:opacity-40"
              >
                {expandingId === node.id ? '细化中…' : '细化'}
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                onClick={() => onDelete(node.id)}
                className="rounded px-2 py-0.5 text-xs text-[var(--color-muted)] hover:text-red-400"
              >
                删
              </button>
            )}
          </div>
        </div>
        {children.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  if (roots.length === 0) {
    return (
      <p className="text-sm text-[var(--color-muted)]">
        还没有考点。粘贴 JD 后点击「开始诊断」生成清单。
      </p>
    );
  }

  return <div className="space-y-0.5">{roots.map((n) => renderNode(n, 0))}</div>;
}
