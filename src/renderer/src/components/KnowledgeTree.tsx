import { useState } from 'react';
import type { KnowledgeNodeView } from '@shared/ipc';
import type { CoverageType, NodeKind, NodeStatus } from '@shared/enums';
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

/** 学习状态机。shaky 会被排程当成复习任务的来源，所以单独给个显眼的颜色 */
const STATUS_META: Record<NodeStatus, { label: string; className: string }> = {
  todo: { label: '未开始', className: 'text-[var(--color-muted)] border-[var(--color-border)]' },
  learning: { label: '学习中', className: 'text-sky-300 border-sky-500/40' },
  shaky: { label: '不牢', className: 'text-amber-300 border-amber-500/40' },
  mastered: { label: '已掌握', className: 'text-emerald-300 border-emerald-500/40' },
};

const STATUS_ORDER: NodeStatus[] = ['todo', 'learning', 'shaky', 'mastered'];

export interface NodePatch {
  name?: string;
  coverageType?: CoverageType;
  status?: NodeStatus;
}

interface TreeProps {
  nodes: KnowledgeNodeView[];
  bookmarkedIds?: Set<string>;
  noteCountByNode?: Map<string, number>;
  onExpand?: (nodeId: string) => void;
  onDelete?: (nodeId: string) => void;
  onToggleBookmark?: (nodeId: string) => void;
  onUpdate?: (nodeId: string, patch: NodePatch) => void;
  onCreateChild?: (parentId: string, name: string, kind: NodeKind) => void;
  onAddNote?: (nodeId: string, noteMd: string) => void;
  expandingId?: string | null;
  /** 有其它长任务进行中时禁用细化 */
  jobsBusy?: boolean;
  selectedNodeId?: string | null;
  onSelectNode?: (nodeId: string) => void;
  /** 非空时只显示这些考点（含祖先节点） */
  visibleNodeIds?: Set<string> | null;
}

/** 层级考点清单 + 进度条，不做图谱可视化 */
export function KnowledgeTree({
  nodes,
  bookmarkedIds,
  noteCountByNode,
  onExpand,
  onDelete,
  onToggleBookmark,
  onUpdate,
  onCreateChild,
  onAddNote,
  expandingId,
  jobsBusy = false,
  selectedNodeId,
  onSelectNode,
  visibleNodeIds,
}: TreeProps): React.JSX.Element {
  const filteredNodes =
    visibleNodeIds && visibleNodeIds.size > 0
      ? nodes.filter((n) => visibleNodeIds.has(n.id))
      : nodes;

  const roots = filteredNodes.filter((n) => !n.parentId);
  const byParent = new Map<string | null, KnowledgeNodeView[]>();
  for (const n of filteredNodes) {
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
        noteCount={noteCountByNode?.get(node.id) ?? 0}
        expanding={expandingId === node.id}
        jobsBusy={jobsBusy}
        onExpand={onExpand}
        onDelete={onDelete}
        onToggleBookmark={onToggleBookmark}
        onUpdate={onUpdate}
        onCreateChild={onCreateChild}
        onAddNote={onAddNote}
        selected={selectedNodeId === node.id}
        onSelect={onSelectNode}
      >
        {children.map((c) => renderNode(c, depth + 1))}
      </NodeRow>
    );
  };

  if (roots.length === 0) {
    return (
      <p className="text-sm text-[var(--color-muted)]">
        {visibleNodeIds && visibleNodeIds.size > 0
          ? '该日无排期考点，试试选择其他日期或查看全部考点'
          : '还没有考点。粘贴 JD 后点击「开始诊断」生成清单。'}
      </p>
    );
  }

  return <div className="min-w-[360px] space-y-0.5">{roots.map((n) => renderNode(n, 0))}</div>;
}

function NodeRow({
  node,
  depth,
  masteryPct,
  bookmarked,
  noteCount,
  expanding,
  jobsBusy,
  onExpand,
  onDelete,
  onToggleBookmark,
  onUpdate,
  onCreateChild,
  onAddNote,
  selected,
  onSelect,
  children,
}: {
  node: KnowledgeNodeView;
  depth: number;
  masteryPct: number;
  bookmarked: boolean;
  noteCount: number;
  expanding: boolean;
  jobsBusy: boolean;
  onExpand?: (nodeId: string) => void;
  onDelete?: (nodeId: string) => void;
  onToggleBookmark?: (nodeId: string) => void;
  onUpdate?: (nodeId: string, patch: NodePatch) => void;
  onCreateChild?: (parentId: string, name: string, kind: NodeKind) => void;
  onAddNote?: (nodeId: string, noteMd: string) => void;
  selected?: boolean;
  onSelect?: (nodeId: string) => void;
  children?: React.ReactNode;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(node.name);
  const [coverage, setCoverage] = useState(node.coverageType);
  const [adding, setAdding] = useState(false);
  const [childName, setChildName] = useState('');
  const [noting, setNoting] = useState(false);
  const [noteText, setNoteText] = useState('');

  const saveEdit = (): void => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const patch: NodePatch = {};
    if (trimmed !== node.name) patch.name = trimmed;
    if (coverage !== node.coverageType) patch.coverageType = coverage;
    if (Object.keys(patch).length > 0) onUpdate?.(node.id, patch);
    setEditing(false);
  };

  const childKind: NodeKind = node.kind === 'domain' ? 'topic' : 'point';

  return (
    <div>
      <div
        className={`rounded-md border px-2 py-2 ${
          selected
            ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10'
            : 'border-transparent hover:border-[var(--color-border)] hover:bg-black/20'
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        <div
          className={`${onSelect && !editing ? 'cursor-pointer' : ''}`}
          onClick={() => {
            if (!editing && onSelect) onSelect(node.id);
          }}
          onKeyDown={(e) => {
            if (!editing && onSelect && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault();
              onSelect(node.id);
            }
          }}
          role={onSelect && !editing ? 'button' : undefined}
          tabIndex={onSelect && !editing ? 0 : undefined}
        >
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
                  className="rounded bg-[var(--color-accent)] px-2 py-0.5 text-xs text-white"
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
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {bookmarked && (
                  <span className="text-amber-400" title="已收藏">
                    ★
                  </span>
                )}
                <span className="text-sm font-medium leading-snug">{node.name}</span>
                <span className="text-[10px] text-[var(--color-muted)]">
                  {KIND_LABEL[node.kind]}
                </span>
                <CoverageBadge type={node.coverageType} />
                {onUpdate ? (
                  <StatusPicker
                    value={node.status}
                    onChange={(status) => onUpdate(node.id, { status })}
                  />
                ) : (
                  <span
                    className={`rounded border px-1.5 py-0.5 text-[10px] ${
                      (STATUS_META[node.status] ?? STATUS_META.todo).className
                    }`}
                  >
                    {(STATUS_META[node.status] ?? STATUS_META.todo).label}
                  </span>
                )}
                {noteCount > 0 && (
                  <span className="text-[10px] text-[var(--color-muted)]" title="已有笔记">
                    📝 {noteCount}
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs leading-relaxed text-[var(--color-muted)]">
                {node.priorityReason}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <div className="h-1.5 w-24 shrink-0 rounded-full bg-[var(--color-border)]">
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
          <div className="mt-2 flex flex-wrap gap-1 border-t border-[var(--color-border)]/50 pt-2">
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
            {onAddNote && (
              <button
                type="button"
                onClick={() => setNoting((v) => !v)}
                className="rounded px-2 py-0.5 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)]"
              >
                笔记
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
                disabled={expanding || jobsBusy}
                onClick={() => onExpand(node.id)}
                className="rounded border border-[var(--color-border)] px-2 py-0.5 text-xs disabled:opacity-40"
              >
                {expanding ? '细化中…' : jobsBusy ? '等待任务…' : '细化'}
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
      {noting && onAddNote && (
        <div className="space-y-1 px-2 py-1" style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}>
          <textarea
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            rows={2}
            placeholder="记一句自己的理解，面试前只看这些"
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!noteText.trim()}
              onClick={() => {
                onAddNote(node.id, noteText.trim());
                setNoteText('');
                setNoting(false);
              }}
              className="rounded bg-[var(--color-accent)] px-2 py-0.5 text-xs text-white disabled:opacity-40"
            >
              保存笔记
            </button>
            <button
              type="button"
              onClick={() => setNoting(false)}
              className="text-xs text-[var(--color-muted)]"
            >
              取消
            </button>
          </div>
        </div>
      )}
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
            className="rounded bg-[var(--color-accent)] px-2 py-1 text-xs text-white disabled:opacity-40"
          >
            添加
          </button>
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * 状态机的手动出口。答题会自动改状态，但自评同样是有效信号——
 * 只让机器改状态会让用户觉得这棵树不是自己的。
 */
function StatusPicker({
  value,
  onChange,
}: {
  value: NodeStatus;
  onChange: (status: NodeStatus) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const meta = STATUS_META[value];

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`rounded border px-1.5 py-0.5 text-[10px] hover:opacity-80 ${meta.className}`}
        title="点击修改学习状态"
      >
        {meta.label}
      </button>
    );
  }

  return (
    <span className="flex gap-1">
      {STATUS_ORDER.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => {
            if (s !== value) onChange(s);
            setOpen(false);
          }}
          className={`rounded border px-1.5 py-0.5 text-[10px] ${STATUS_META[s].className} ${
            s === value ? 'bg-black/40' : 'hover:bg-black/20'
          }`}
        >
          {STATUS_META[s].label}
        </button>
      ))}
    </span>
  );
}
