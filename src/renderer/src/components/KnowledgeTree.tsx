import { useState } from 'react';
import type { KnowledgeNodeView } from '@shared/ipc';
import type { CoverageType, NodeKind } from '@shared/enums';
import { CoverageBadge } from './CoverageBadge';

const KIND_LABEL: Record<NodeKind, string> = {
  domain: '领域',
  topic: '主题',
  point: '知识点',
};

const COVERAGE_OPTIONS: { value: CoverageType; label: string }[] = [
  { value: 'deepDive', label: '必深挖' },
  { value: 'gap', label: '短板' },
  { value: 'landmine', label: '雷区' },
  { value: 'extra', label: '加分项' },
];

interface TreeProps {
  nodes: KnowledgeNodeView[];
  bookmarkedIds?: Set<string>;
  onExpand?: (nodeId: string) => void;
  onDelete?: (nodeId: string) => void;
  onToggleBookmark?: (nodeId: string) => void;
  onUpdate?: (nodeId: string, patch: { name?: string; coverageType?: CoverageType }) => void;
  onCreateChild?: (parentId: string, name: string, kind: NodeKind) => void;
  expandingId?: string | null;
}

/** 层级考点清单 + 进度条，不做图谱可视化 */
export function KnowledgeTree({
  nodes,
  bookmarkedIds,
  onExpand,
  onDelete,
  onToggleBookmark,
  onUpdate,
  onCreateChild,
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
      <NodeRow
        key={node.id}
        node={node}
        depth={depth}
        masteryPct={masteryPct}
        bookmarked={bookmarkedIds?.has(node.id) ?? false}
        expanding={expandingId === node.id}
        onExpand={onExpand}
        onDelete={onDelete}
        onToggleBookmark={onToggleBookmark}
        onUpdate={onUpdate}
        onCreateChild={onCreateChild}
      >
        {children.map((c) => renderNode(c, depth + 1))}
      </NodeRow>
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

function NodeRow({
  node,
  depth,
  masteryPct,
  bookmarked,
  expanding,
  onExpand,
  onDelete,
  onToggleBookmark,
  onUpdate,
  onCreateChild,
  children,
}: {
  node: KnowledgeNodeView;
  depth: number;
  masteryPct: number;
  bookmarked: boolean;
  expanding: boolean;
  onExpand?: (nodeId: string) => void;
  onDelete?: (nodeId: string) => void;
  onToggleBookmark?: (nodeId: string) => void;
  onUpdate?: (nodeId: string, patch: { name?: string; coverageType?: CoverageType }) => void;
  onCreateChild?: (parentId: string, name: string, kind: NodeKind) => void;
  children?: React.ReactNode;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(node.name);
  const [coverage, setCoverage] = useState(node.coverageType);
  const [adding, setAdding] = useState(false);
  const [childName, setChildName] = useState('');

  const saveEdit = (): void => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const patch: { name?: string; coverageType?: CoverageType } = {};
    if (trimmed !== node.name) patch.name = trimmed;
    if (coverage !== node.coverageType) patch.coverageType = coverage;
    if (Object.keys(patch).length > 0) onUpdate?.(node.id, patch);
    setEditing(false);
  };

  const childKind: NodeKind = node.kind === 'domain' ? 'topic' : 'point';

  return (
    <div>
      <div
        className="flex items-start gap-2 rounded-md border border-transparent px-2 py-2 hover:border-[var(--color-border)] hover:bg-black/20"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="space-y-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm"
              />
              <select
                value={coverage}
                onChange={(e) => setCoverage(e.target.value as CoverageType)}
                className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs"
              >
                {COVERAGE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={saveEdit}
                  className="rounded bg-[var(--color-accent)] px-2 py-0.5 text-xs"
                >
                  保存
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setName(node.name);
                    setCoverage(node.coverageType);
                    setEditing(false);
                  }}
                  className="text-xs text-[var(--color-muted)]"
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {bookmarked && (
                  <span className="text-amber-400" title="已收藏">
                    ★
                  </span>
                )}
                <span className="text-sm font-medium">{node.name}</span>
                <span className="text-[10px] text-[var(--color-muted)]">
                  {KIND_LABEL[node.kind]}
                </span>
                <CoverageBadge type={node.coverageType} />
              </div>
              <p className="mt-1 text-xs text-[var(--color-muted)]">{node.priorityReason}</p>
              <div className="mt-2 flex items-center gap-2">
                <div className="h-1.5 max-w-[120px] flex-1 rounded-full bg-[var(--color-border)]">
                  <div
                    className="h-full rounded-full bg-[var(--color-accent)]"
                    style={{ width: `${masteryPct}%` }}
                  />
                </div>
                <span className="text-[10px] text-[var(--color-muted)]">
                  掌握 {node.mastery}/5 · {node.estMinutes}min
                </span>
              </div>
            </>
          )}
        </div>
        {!editing && (
          <div className="flex shrink-0 flex-wrap justify-end gap-1">
            {onToggleBookmark && (
              <button
                type="button"
                onClick={() => onToggleBookmark(node.id)}
                className={`rounded px-2 py-0.5 text-xs ${
                  bookmarked ? 'text-amber-400' : 'text-[var(--color-muted)] hover:text-amber-400'
                }`}
                title="收藏考点"
              >
                {bookmarked ? '★' : '☆'}
              </button>
            )}
            {onUpdate && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="rounded px-2 py-0.5 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)]"
              >
                编辑
              </button>
            )}
            {onCreateChild && node.kind !== 'point' && (
              <button
                type="button"
                onClick={() => setAdding((v) => !v)}
                className="rounded px-2 py-0.5 text-xs text-sky-400"
              >
                +子节点
              </button>
            )}
            {(node.kind === 'domain' || node.kind === 'topic') && onExpand && (
              <button
                type="button"
                disabled={expanding}
                onClick={() => onExpand(node.id)}
                className="rounded border border-[var(--color-border)] px-2 py-0.5 text-xs disabled:opacity-40"
              >
                {expanding ? '细化中…' : '细化'}
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
        )}
      </div>
      {adding && onCreateChild && (
        <div
          className="flex gap-2 px-2 py-1"
          style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
        >
          <input
            value={childName}
            onChange={(e) => setChildName(e.target.value)}
            placeholder={`新${KIND_LABEL[childKind]}名称`}
            className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs"
          />
          <button
            type="button"
            disabled={!childName.trim()}
            onClick={() => {
              onCreateChild(node.id, childName.trim(), childKind);
              setChildName('');
              setAdding(false);
            }}
            className="rounded bg-[var(--color-accent)] px-2 py-1 text-xs disabled:opacity-40"
          >
            添加
          </button>
        </div>
      )}
      {children}
    </div>
  );
}
