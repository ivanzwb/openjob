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
    [...nodes].sort(
      (a, b) =>
        a.difficulty - b.difficulty ||
        b.priorityScore - a.priorityScore ||
        // 同难度同优先级时用 id 收尾，把顺序定死。少了这一档，排序结果就取决于
        // 调用方查询返回的行序：那个顺序两端并不一致（各自的插入/同步落库顺序
        // 不同），VACUUM 过一次（快照、回退都会）还会再变一次。而这种并列很常见
        // ——同一批生成的兄弟考点往往覆盖类型、考察概率、时长都一样，算出来的
        // 优先级完全相同。id 是 UUID 且随同步一起过去，两端必然排成同一个样子。
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    ),
    edges,
  );
}
