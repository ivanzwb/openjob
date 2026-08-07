import { useState } from 'react';
import type { KnowledgeNodeView, NodeEdgeView } from '@shared/ipc';
import type { EdgeRelation } from '@shared/enums';

const RELATION_OPTIONS: Array<{ value: EdgeRelation; label: string; hint: string }> = [
  { value: 'prerequisite', label: '前置', hint: '不先懂 A 就学不动 B，会影响排期顺序' },
  { value: 'related', label: '相关', hint: '常被一起追问' },
  { value: 'contrast', label: '对比', hint: '常被拿来对比' },
];

const RELATION_LABEL: Record<EdgeRelation, string> = {
  prerequisite: '前置',
  related: '相关',
  contrast: '对比',
};

/**
 * 知识点横向关系的编辑面板。
 * prerequisite 直接决定排期顺序，所以在提示文案里点明这一点。
 */
export function EdgeEditor({
  nodes,
  edges,
  onCreate,
  onDelete,
}: {
  nodes: KnowledgeNodeView[];
  edges: NodeEdgeView[];
  onCreate: (fromNodeId: string, toNodeId: string, relation: EdgeRelation) => void;
  onDelete: (id: string) => void;
}): React.JSX.Element {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [relation, setRelation] = useState<EdgeRelation>('prerequisite');
  const [error, setError] = useState<string | null>(null);

  const selectable = nodes.filter((n) => n.kind !== 'domain');
  const hint = RELATION_OPTIONS.find((o) => o.value === relation)?.hint ?? '';

  const submit = (): void => {
    setError(null);
    if (!from || !to) return setError('请选择两个考点');
    if (from === to) return setError('不能连到自己');
    onCreate(from, to, relation);
    setFrom('');
    setTo('');
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <select
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs"
          >
            <option value="">起点考点…</option>
            {selectable.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </select>
          <select
            value={relation}
            onChange={(e) => setRelation(e.target.value as EdgeRelation)}
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs"
          >
            {RELATION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs"
          >
            <option value="">终点考点…</option>
            {selectable.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </select>
        </div>
        <p className="text-[10px] text-[var(--color-muted)]">{hint}</p>
        <button
          type="button"
          onClick={submit}
          className="rounded bg-[var(--color-accent)] px-2 py-1 text-xs"
        >
          添加关系
        </button>
        {error && <p className="text-[10px] text-red-400">{error}</p>}
      </div>

      {edges.length === 0 ? (
        <p className="text-xs text-[var(--color-muted)]">
          还没有横向关系。诊断 JD 时会自动生成一批，也可以手动补。
        </p>
      ) : (
        <ul className="space-y-1">
          {edges.map((e) => (
            <li
              key={e.id}
              className="flex items-center justify-between gap-2 rounded border border-[var(--color-border)] px-2 py-1 text-xs"
            >
              <span className="min-w-0 truncate">
                {e.fromName}
                <span className="mx-1 text-[var(--color-muted)]">
                  ─{RELATION_LABEL[e.relation]}→
                </span>
                {e.toName}
              </span>
              <button
                type="button"
                onClick={() => onDelete(e.id)}
                className="shrink-0 text-[var(--color-muted)] hover:text-red-400"
              >
                删
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
