import type { TaskView } from './ipc';

export function nodeIdsForPlanFilter(
  nodes: { id: string; parentId: string | null }[],
  tasks: TaskView[],
): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ids = new Set<string>();
  for (const task of tasks) {
    if (!task.nodeId) continue;
    let id: string | null = task.nodeId;
    while (id) {
      ids.add(id);
      id = byId.get(id)?.parentId ?? null;
    }
  }
  return ids;
}
