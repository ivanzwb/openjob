import type { TaskView } from './ipc';

/** 日历筛选可见考点：当日任务关联节点 + 祖先（树结构）+ 全部后代（含细化子节点） */
export function nodeIdsForPlanFilter(
  nodes: { id: string; parentId: string | null }[],
  tasks: TaskView[],
): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childrenByParent = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.parentId) continue;
    const list = childrenByParent.get(n.parentId) ?? [];
    list.push(n.id);
    childrenByParent.set(n.parentId, list);
  }

  const ids = new Set<string>();

  const addAncestors = (nodeId: string): void => {
    let id: string | null = nodeId;
    while (id) {
      ids.add(id);
      id = byId.get(id)?.parentId ?? null;
    }
  };

  const addDescendants = (nodeId: string): void => {
    const queue = [nodeId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (ids.has(id)) {
        for (const childId of childrenByParent.get(id) ?? []) {
          queue.push(childId);
        }
        continue;
      }
      ids.add(id);
      for (const childId of childrenByParent.get(id) ?? []) {
        queue.push(childId);
      }
    }
  };

  for (const task of tasks) {
    if (!task.nodeId) continue;
    addAncestors(task.nodeId);
    addDescendants(task.nodeId);
  }

  return ids;
}
