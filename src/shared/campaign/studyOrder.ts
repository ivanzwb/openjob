import type { EdgeRelation } from '@shared/enums';

export function topoSortByPrerequisite<T extends { id: string }>(
  ordered: T[],
  edges: Array<{ fromNodeId: string; toNodeId: string; relation: EdgeRelation }>,
): T[] {
  const present = new Set(ordered.map((n) => n.id));
  const indegree = new Map<string, number>(ordered.map((n) => [n.id, 0]));
  const dependents = new Map<string, string[]>();

  for (const e of edges) {
    if (e.relation !== 'prerequisite') continue;
    if (!present.has(e.fromNodeId) || !present.has(e.toNodeId)) continue;
    indegree.set(e.toNodeId, (indegree.get(e.toNodeId) ?? 0) + 1);
    const list = dependents.get(e.fromNodeId) ?? [];
    list.push(e.toNodeId);
    dependents.set(e.fromNodeId, list);
  }

  const byId = new Map(ordered.map((n) => [n.id, n]));
  const out: T[] = [];
  const emitted = new Set<string>();

  while (out.length < ordered.length) {
    const next = ordered.find((n) => !emitted.has(n.id) && (indegree.get(n.id) ?? 0) === 0);
    if (!next) break;
    out.push(next);
    emitted.add(next.id);
    for (const dep of dependents.get(next.id) ?? []) {
      indegree.set(dep, (indegree.get(dep) ?? 1) - 1);
    }
  }

  for (const n of ordered) {
    if (!emitted.has(n.id)) out.push(byId.get(n.id)!);
  }
  return out;
}

export function sortNodesByStudyOrder<
  T extends { id: string; difficulty: number; priorityScore: number },
>(
  nodes: T[],
  edges: Array<{ fromNodeId: string; toNodeId: string; relation: EdgeRelation }>,
): T[] {
  return topoSortByPrerequisite(
    [...nodes].sort((a, b) => a.difficulty - b.difficulty || b.priorityScore - a.priorityScore),
    edges,
  );
}
