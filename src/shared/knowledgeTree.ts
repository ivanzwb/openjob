/**
 * 考点树的形状装配：把一串扁平节点按父子关系分组，供两端各自渲染。
 *
 * 抽到共享层是因为两端的树是各写一遍的（React DOM / React Native），而「哪些行
 * 算根」这个判断出过事故：parentId 可能是 null、undefined 或空串（同步过来的行、
 * 手工造的数据都出现过），只认 null 会让整棵树凭空消失。规则只留一份，两端就
 * 不会再各自漂移。
 */

/**
 * 按父节点分组。祖先链断了的节点当根返回，不是丢掉。
 *
 * knowledge_node.parent_id 既没有外键也没有级联，所以删掉中间层之后，它的后代
 * 会留着一个指不到任何行的 parent_id。树如果只从 `!parentId` 开始递归，这些行
 * 就既不是根、又没有父节点会去递归它们——从考点清单里彻底消失，可它们还在库里、
 * 还被排程、还算进统计。用户看到的是「考点少了一批，但进度和日程还带着它们」。
 *
 * 层级越深越容易踩到：手机端曾经允许把 point 继续细化（那道门后来补上了，见
 * canExpandNode），已经存在的四层、五层数据只要中间任何一层被删过就会中断。
 * 把断链的节点提到根上，至少能看见、能点、能删。
 */
export function groupNodesByParent<T extends { id: string; parentId: string | null }>(
  nodes: T[],
): Map<string | null, T[]> {
  const presentIds = new Set(nodes.map((n) => n.id));
  const byParent = new Map<string | null, T[]>();

  for (const node of nodes) {
    const parentId = node.parentId && presentIds.has(node.parentId) ? node.parentId : null;
    const list = byParent.get(parentId) ?? [];
    list.push(node);
    byParent.set(parentId, list);
  }

  return byParent;
}

/**
 * 收集某个节点连着它所有后代的 id（含自己）。
 *
 * 删除入口要用：parent_id 没有级联，删一行不会带走底下的行，得先知道要删哪些、
 * 有多少，才能在确认框里说清楚代价。层数不定（历史数据可能有四五层），所以逐层
 * 往下收；顺手挡掉父子互指的坏数据，不然会原地转圈。
 */
export function collectSubtreeIds<T extends { id: string; parentId: string | null }>(
  nodes: T[],
  rootId: string,
): string[] {
  const byParent = new Map<string, T[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const list = byParent.get(node.parentId) ?? [];
    list.push(node);
    byParent.set(node.parentId, list);
  }

  const ids = new Set<string>([rootId]);
  let frontier = [rootId];

  while (frontier.length > 0) {
    const next: string[] = [];
    for (const parentId of frontier) {
      for (const child of byParent.get(parentId) ?? []) {
        if (ids.has(child.id)) continue;
        ids.add(child.id);
        next.push(child.id);
      }
    }
    frontier = next;
  }

  return [...ids];
}
