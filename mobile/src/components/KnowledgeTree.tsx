import { useEffect, useMemo, useRef, useState } from 'react';
import { findNodeHandle, Pressable, Text, TextInput, View } from 'react-native';
import type { ScrollView } from 'react-native';
import type { CoverageType, NodeKind, NodeStatus } from '@shared/enums';
import type { KnowledgeNodeView } from '@shared/ipc';
import { useTheme } from '../theme';

const KIND_LABEL: Record<NodeKind, string> = {
  domain: '领域',
  topic: '主题',
  point: '知识点',
};

const COVERAGE_LABEL: Record<CoverageType, string> = {
  deepDive: '必深挖',
  gap: '短板',
  landmine: '雷区',
  extra: '加分项',
};

const STATUS_META: Record<NodeStatus, { label: string; color: string }> = {
  todo: { label: '未开始', color: '#94a3b8' },
  learning: { label: '学习中', color: '#38bdf8' },
  shaky: { label: '不牢', color: '#f59e0b' },
  mastered: { label: '已掌握', color: '#34d399' },
};

const STATUS_ORDER: NodeStatus[] = ['todo', 'learning', 'shaky', 'mastered'];

export interface NodePatch {
  status?: NodeStatus;
}

interface KnowledgeTreeProps {
  nodes: KnowledgeNodeView[];
  selectedNodeId?: string | null;
  visibleNodeIds?: Set<string> | null;
  expandingId?: string | null;
  scrollContainerRef?: React.RefObject<ScrollView | null>;
  renderNodeDetail?: (node: KnowledgeNodeView) => React.ReactNode;
  onSelectNode?: (nodeId: string) => void;
  onExpand?: (nodeId: string) => void;
  onUpdate?: (nodeId: string, patch: NodePatch) => void;
  onCreateChild?: (parentId: string, name: string) => void;
}

export function KnowledgeTree({
  nodes,
  selectedNodeId,
  visibleNodeIds,
  expandingId,
  scrollContainerRef,
  renderNodeDetail,
  onSelectNode,
  onExpand,
  onUpdate,
  onCreateChild,
}: KnowledgeTreeProps): React.JSX.Element {
  const theme = useTheme();
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const nodeRefs = useRef(new Map<string, View>());
  const parentById = useMemo(() => new Map(nodes.map((node) => [node.id, node.parentId])), [nodes]);
  const selectedAncestorIds = useMemo(() => {
    const ancestors = new Set<string>();
    let parentId = selectedNodeId ? parentById.get(selectedNodeId) : null;
    while (parentId) {
      ancestors.add(parentId);
      parentId = parentById.get(parentId) ?? null;
    }
    return ancestors;
  }, [parentById, selectedNodeId]);

  useEffect(() => {
    if (!selectedNodeId || !scrollContainerRef?.current) return;
    const row = nodeRefs.current.get(selectedNodeId);
    const scrollView = scrollContainerRef.current;
    const scrollHandle = findNodeHandle(scrollView);
    if (!row || !scrollHandle) return;

    const timer = setTimeout(() => {
      row.measureLayout(
        scrollHandle,
        (_x, y) => {
          scrollView.scrollTo({ y: Math.max(0, y - 96), animated: true });
        },
        () => undefined,
      );
    }, 0);

    return () => clearTimeout(timer);
  }, [scrollContainerRef, selectedNodeId, visibleNodeIds]);

  const filtered = visibleNodeIds ? nodes.filter((n) => visibleNodeIds.has(n.id)) : nodes;
  // 根节点按 falsy 判定，和桌面端一致：parentId 可能是 null、undefined 或空串
  // （同步过来的行、手工造的数据都出现过），只认 null 会让整棵树凭空消失。
  const byParent = new Map<string | null, KnowledgeNodeView[]>();
  for (const node of filtered) {
    const key = node.parentId || null;
    const list = byParent.get(key) ?? [];
    list.push(node);
    byParent.set(key, list);
  }
  const roots = byParent.get(null) ?? [];

  const toggleChildren = (nodeId: string): void => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  const renderNode = (node: KnowledgeNodeView, depth: number): React.JSX.Element => {
    const children = byParent.get(node.id) ?? [];
    const collapsed = collapsedIds.has(node.id) && !selectedAncestorIds.has(node.id);
    return (
      <NodeRow
        key={node.id}
        node={node}
        depth={depth}
        selected={selectedNodeId === node.id}
        expanding={expandingId === node.id}
        hasChildren={children.length > 0}
        childrenCollapsed={collapsed}
        onToggleChildren={toggleChildren}
        onSelect={onSelectNode}
        rowRef={(el) => {
          if (el) nodeRefs.current.set(node.id, el);
          else nodeRefs.current.delete(node.id);
        }}
        onExpand={onExpand}
        onUpdate={onUpdate}
        onCreateChild={onCreateChild}
        detail={renderNodeDetail?.(node)}
      >
        {!collapsed && children.map((child) => renderNode(child, depth + 1))}
      </NodeRow>
    );
  };

  if (roots.length === 0) {
    return (
      <Text style={{ color: theme.muted, fontSize: 12 }}>
        {visibleNodeIds ? '该日无排期考点' : '暂无考点'}
      </Text>
    );
  }

  return <View style={{ gap: 6 }}>{roots.map((node) => renderNode(node, 0))}</View>;
}

function NodeRow({
  node,
  depth,
  selected,
  expanding,
  hasChildren,
  childrenCollapsed,
  onToggleChildren,
  onSelect,
  rowRef,
  onExpand,
  onUpdate,
  onCreateChild,
  detail,
  children,
}: {
  node: KnowledgeNodeView;
  depth: number;
  selected: boolean;
  expanding: boolean;
  hasChildren: boolean;
  childrenCollapsed: boolean;
  onToggleChildren: (nodeId: string) => void;
  onSelect?: (nodeId: string) => void;
  rowRef?: (el: View | null) => void;
  onExpand?: (nodeId: string) => void;
  onUpdate?: (nodeId: string, patch: NodePatch) => void;
  onCreateChild?: (parentId: string, name: string) => void;
  detail?: React.ReactNode;
  children?: React.ReactNode;
}): React.JSX.Element {
  const theme = useTheme();
  const [statusOpen, setStatusOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [childName, setChildName] = useState('');
  const masteryPct = Math.round((node.mastery / 5) * 100);
  const status = STATUS_META[node.status] ?? STATUS_META.todo;

  return (
    <View ref={rowRef}>
      <Pressable
        onPress={() => onSelect?.(node.id)}
        style={{
          marginLeft: depth * 14,
          borderWidth: 1,
          borderColor: selected ? theme.accent : theme.border,
          borderRadius: 10,
          padding: 10,
          backgroundColor: selected ? `${theme.accent}18` : theme.surface,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {hasChildren ? (
            <Pressable
              onPress={(event) => {
                event.stopPropagation();
                onToggleChildren(node.id);
              }}
              hitSlop={10}
              style={{
                width: 32,
                height: 32,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 8,
              }}
            >
              <Text style={{ color: theme.muted, fontSize: 22, lineHeight: 26 }}>
                {childrenCollapsed ? '▸' : '▾'}
              </Text>
            </Pressable>
          ) : (
            <Text style={{ width: 32 }} />
          )}
          <Text style={{ color: theme.text, flex: 1, fontWeight: selected ? '700' : '600' }}>
            {node.name}
          </Text>
          {node.hasExplanation && (
            <Text accessibilityLabel="已生成讲解" style={{ color: theme.accent, fontSize: 15 }}>
              📖
            </Text>
          )}
        </View>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
          <Text style={{ color: theme.muted, fontSize: 10 }}>{KIND_LABEL[node.kind]}</Text>
          <Text style={{ color: theme.accent, fontSize: 10 }}>
            {COVERAGE_LABEL[node.coverageType]}
          </Text>
          <Pressable
            onPress={(event) => {
              event.stopPropagation();
              setStatusOpen((open) => !open);
            }}
            style={{ borderWidth: 1, borderColor: status.color, borderRadius: 999, paddingHorizontal: 6 }}
          >
            <Text style={{ color: status.color, fontSize: 10 }}>{status.label}</Text>
          </Pressable>
        </View>

        {statusOpen && (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {STATUS_ORDER.map((nextStatus) => (
              <Pressable
                key={nextStatus}
                onPress={(event) => {
                  event.stopPropagation();
                  onUpdate?.(node.id, { status: nextStatus });
                  setStatusOpen(false);
                }}
                style={{
                  borderWidth: 1,
                  borderColor: STATUS_META[nextStatus].color,
                  borderRadius: 999,
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                  backgroundColor: nextStatus === node.status ? `${STATUS_META[nextStatus].color}22` : 'transparent',
                }}
              >
                <Text style={{ color: STATUS_META[nextStatus].color, fontSize: 11 }}>
                  {STATUS_META[nextStatus].label}
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <View style={{ width: 88, height: 5, borderRadius: 999, backgroundColor: theme.border }}>
            <View
              style={{
                width: `${masteryPct}%`,
                height: 5,
                borderRadius: 999,
                backgroundColor: theme.accent,
              }}
            />
          </View>
          <Text style={{ color: theme.muted, fontSize: 10 }}>
            掌握 {node.mastery.toFixed(1)}/5 · {node.estMinutes}min
          </Text>
        </View>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
          {onExpand && (
            <Pressable
              onPress={(event) => {
                event.stopPropagation();
                onExpand(node.id);
              }}
              disabled={expanding}
            >
              <Text style={{ color: expanding ? theme.muted : theme.accent, fontSize: 12 }}>
                {expanding ? '细化中…' : '细化'}
              </Text>
            </Pressable>
          )}
          {onCreateChild && (
            <Pressable
              onPress={(event) => {
                event.stopPropagation();
                setAdding((open) => !open);
              }}
            >
              <Text style={{ color: theme.muted, fontSize: 12 }}>+ 子考点</Text>
            </Pressable>
          )}
        </View>

        {adding && (
          <View style={{ gap: 6, marginTop: 8 }}>
            <TextInput
              value={childName}
              onChangeText={setChildName}
              placeholder="新子考点名称"
              placeholderTextColor={theme.muted}
              style={{
                color: theme.text,
                borderWidth: 1,
                borderColor: theme.border,
                borderRadius: 8,
                paddingHorizontal: 8,
                paddingVertical: 6,
                fontSize: 12,
              }}
            />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Pressable
                disabled={!childName.trim()}
                onPress={(event) => {
                  event.stopPropagation();
                  onCreateChild?.(node.id, childName.trim());
                  setChildName('');
                  setAdding(false);
                }}
              >
                <Text style={{ color: childName.trim() ? theme.accent : theme.muted, fontSize: 12 }}>
                  添加
                </Text>
              </Pressable>
              <Pressable
                onPress={(event) => {
                  event.stopPropagation();
                  setAdding(false);
                }}
              >
                <Text style={{ color: theme.muted, fontSize: 12 }}>取消</Text>
              </Pressable>
            </View>
          </View>
        )}
      </Pressable>
      {detail}
      <View style={{ marginTop: 6, gap: 6 }}>{children}</View>
    </View>
  );
}
