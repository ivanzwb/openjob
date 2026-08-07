import { useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { KnowledgeNodeView } from '@shared/ipc';
import type { CoverageType } from '@shared/enums';

const COVERAGE_COLOR: Record<CoverageType, string> = {
  deepDive: '#f59e0b',
  gap: '#38bdf8',
  landmine: '#f87171',
  extra: '#a3a3a3',
};

function layoutTree(nodes: KnowledgeNodeView[]): { flowNodes: Node[]; flowEdges: Edge[] } {
  const byParent = new Map<string | null, KnowledgeNodeView[]>();
  for (const n of nodes) {
    const list = byParent.get(n.parentId) ?? [];
    list.push(n);
    byParent.set(n.parentId, list);
  }

  const flowNodes: Node[] = [];
  const flowEdges: Edge[] = [];
  const xGap = 220;
  const yGap = 72;

  const place = (node: KnowledgeNodeView, depth: number, index: number): void => {
    flowNodes.push({
      id: node.id,
      position: { x: depth * xGap, y: index * yGap },
      data: { label: node.name },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      style: {
        borderColor: COVERAGE_COLOR[node.coverageType],
        borderWidth: 2,
        fontSize: 12,
        padding: 8,
        borderRadius: 8,
        background: 'var(--color-surface)',
        color: 'var(--color-fg)',
        maxWidth: 180,
      },
    });

    const children = byParent.get(node.id) ?? [];
    children.forEach((child, ci) => {
      flowEdges.push({
        id: `${node.id}-${child.id}`,
        source: node.id,
        target: child.id,
        animated: child.mastery < 3,
      });
      place(child, depth + 1, index + ci + 1);
    });
  };

  const roots = byParent.get(null) ?? [];
  let row = 0;
  for (const root of roots) {
    place(root, 0, row);
    row += (byParent.get(root.id)?.length ?? 0) + 2;
  }

  return { flowNodes, flowEdges };
}

export function KnowledgeGraph({ nodes }: { nodes: KnowledgeNodeView[] }): React.JSX.Element {
  const { flowNodes, flowEdges } = useMemo(() => layoutTree(nodes), [nodes]);

  if (nodes.length === 0) {
    return (
      <p className="text-sm text-[var(--color-muted)]">暂无考点，诊断 JD 后可查看图谱</p>
    );
  }

  return (
    <div className="h-[420px] w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
      <ReactFlow nodes={flowNodes} edges={flowEdges} fitView minZoom={0.3} maxZoom={1.5}>
        <Background gap={16} />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}
