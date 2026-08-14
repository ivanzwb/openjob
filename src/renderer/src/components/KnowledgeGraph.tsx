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
import type { KnowledgeNodeView, NodeEdgeView } from '@shared/ipc';
import type { CoverageType, EdgeRelation } from '@shared/enums';
import { useUiTheme } from '../lib/uiTheme';

const COVERAGE_COLOR: Record<CoverageType, string> = {
  deepDive: '#f59e0b',
  gap: '#38bdf8',
  landmine: '#f87171',
  extra: '#a3a3a3',
};

/** 横向关系单独配色，和层级边区分开，否则一眼看不出哪条是前置 */
const RELATION_STYLE: Record<EdgeRelation, { stroke: string; dash?: string; label: string }> = {
  prerequisite: { stroke: '#34d399', label: '前置' },
  related: { stroke: '#818cf8', dash: '4 4', label: '相关' },
  contrast: { stroke: '#fb923c', dash: '2 3', label: '对比' },
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

export function KnowledgeGraph({
  nodes,
  edges = [],
}: {
  nodes: KnowledgeNodeView[];
  edges?: NodeEdgeView[];
}): React.JSX.Element {
  const uiTheme = useUiTheme();
  const { flowNodes, flowEdges } = useMemo(() => {
    const tree = layoutTree(nodes);
    const present = new Set(nodes.map((n) => n.id));

    for (const e of edges) {
      if (!present.has(e.fromNodeId) || !present.has(e.toNodeId)) continue;
      const style = RELATION_STYLE[e.relation];
      tree.flowEdges.push({
        id: `rel-${e.id}`,
        source: e.fromNodeId,
        target: e.toNodeId,
        label: style.label,
        labelStyle: { fill: style.stroke, fontSize: 10 },
        labelBgStyle: { fill: 'var(--color-surface)' },
        style: { stroke: style.stroke, strokeDasharray: style.dash },
      });
    }
    return tree;
  }, [nodes, edges]);

  if (nodes.length === 0) {
    return (
      <p className="text-sm text-[var(--color-muted)]">暂无考点，诊断 JD 后可查看图谱</p>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="knowledge-graph-host relative min-h-0 flex-1 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
        <ReactFlow
          className="knowledge-graph-flow"
          colorMode={uiTheme}
          nodes={flowNodes}
          edges={flowEdges}
          fitView
          minZoom={0.3}
          maxZoom={1.5}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={16} color="var(--color-border)" />
          <Controls position="bottom-left" showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            position="bottom-right"
            bgColor="var(--color-surface)"
            maskColor="rgb(79 124 255 / 0.14)"
            nodeColor={(node) => (node.style?.borderColor as string) ?? 'var(--color-muted)'}
            nodeStrokeColor="var(--color-border)"
            style={{
              backgroundColor: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 8,
            }}
          />
        </ReactFlow>
      </div>
      {edges.length > 0 && (
        <div className="flex flex-wrap gap-3 text-[10px] text-[var(--color-muted)]">
          {(Object.keys(RELATION_STYLE) as EdgeRelation[]).map((r) => (
            <span key={r} className="flex items-center gap-1">
              <span
                className="inline-block h-0.5 w-4"
                style={{ background: RELATION_STYLE[r].stroke }}
              />
              {RELATION_STYLE[r].label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
