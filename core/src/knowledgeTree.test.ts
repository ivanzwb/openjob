/**
 * 守「以前细化超过三层的数据必须照原样显示」。
 *
 * 手机端曾经允许把 point 继续细化，用户库里已经有四层、五层甚至更深的考点。
 * 那道门后来补上了（canExpandNode），但既有数据一行不动，只能靠渲染侧不作任何
 * 深度假设来保证它们看得见。
 *
 * 最危险的不是深度本身，而是断链：knowledge_node.parent_id 既没有外键也没有
 * 级联，删掉中间层之后后代会留着指不到任何行的 parent_id。树只从 `!parentId`
 * 递归的话，这些行既不是根、又没有父节点会去递归它们——从清单里消失，而排程和
 * 统计照旧带着它们。谁把断链节点重新丢掉，这里要红。
 */
import { describe, expect, it } from 'vitest';
import { collectSubtreeIds, groupNodesByParent } from './knowledgeTree';

const ids = (nodes: { id: string }[] | undefined): string[] => (nodes ?? []).map((n) => n.id).sort();

describe('考点树按父子分组', () => {
  it('正常三层树照常挂好', () => {
    const byParent = groupNodesByParent([
      { id: 'd1', parentId: null },
      { id: 't1', parentId: 'd1' },
      { id: 'p1', parentId: 't1' },
    ]);

    expect(ids(byParent.get(null))).toEqual(['d1']);
    expect(ids(byParent.get('d1'))).toEqual(['t1']);
    expect(ids(byParent.get('t1'))).toEqual(['p1']);
  });

  it('超过三层的老数据一层不少', () => {
    const byParent = groupNodesByParent([
      { id: 'd1', parentId: null },
      { id: 't1', parentId: 'd1' },
      { id: 'p1', parentId: 't1' },
      { id: 'p2', parentId: 'p1' },
      { id: 'p3', parentId: 'p2' },
      { id: 'p4', parentId: 'p3' },
    ]);

    expect(ids(byParent.get(null))).toEqual(['d1']);
    expect(ids(byParent.get('p1'))).toEqual(['p2']);
    expect(ids(byParent.get('p2'))).toEqual(['p3']);
    expect(ids(byParent.get('p3'))).toEqual(['p4']);
  });

  it('中间层被删过的子树提到根上，而不是消失', () => {
    // t1 已经不在了，p1 的 parent_id 还指着它
    const byParent = groupNodesByParent([
      { id: 'd1', parentId: null },
      { id: 'p1', parentId: 't1' },
      { id: 'p2', parentId: 'p1' },
    ]);

    // p1 断了链，当根显示；它自己的子树关系保持不变
    expect(ids(byParent.get(null))).toEqual(['d1', 'p1']);
    expect(ids(byParent.get('p1'))).toEqual(['p2']);
    // 不该有挂在幽灵父节点下的分组
    expect(byParent.has('t1')).toBe(false);
  });

  it('parentId 是空串的行也当根，不能让整棵树消失', () => {
    // 同步过来的行、手工造的数据都出现过空串
    const byParent = groupNodesByParent([
      { id: 'd1', parentId: '' },
      { id: 't1', parentId: 'd1' },
    ]);

    expect(ids(byParent.get(null))).toEqual(['d1']);
    expect(ids(byParent.get('d1'))).toEqual(['t1']);
  });

  it('每一行都恰好出现一次，不重不漏', () => {
    const nodes = [
      { id: 'd1', parentId: null },
      { id: 't1', parentId: 'd1' },
      { id: 'p1', parentId: 'ghost' },
      { id: 'p2', parentId: 'p1' },
    ];

    const grouped = [...groupNodesByParent(nodes).values()].flat();

    expect(grouped).toHaveLength(nodes.length);
    expect(ids(grouped)).toEqual(['d1', 'p1', 'p2', 't1']);
  });
});

/**
 * 守删除入口的连带范围。parent_id 没有级联，只删一行会把后代变成断链数据——
 * 它们会被提到最外层显示，用户以为删掉了、结果考点跑到了根上。
 */
describe('收集子树 id', () => {
  const nodes = [
    { id: 'd1', parentId: null },
    { id: 't1', parentId: 'd1' },
    { id: 'p1', parentId: 't1' },
    { id: 'p2', parentId: 'p1' },
    { id: 't2', parentId: 'd1' },
  ];

  it('叶子节点只收自己', () => {
    expect(collectSubtreeIds(nodes, 'p2')).toEqual(['p2']);
  });

  it('中间层要把任意深度的后代都收上来', () => {
    // 历史遗留的 point→point 深链，一层一层删太痛苦，也留不下干净的树
    expect(collectSubtreeIds(nodes, 't1').sort()).toEqual(['p1', 'p2', 't1']);
  });

  it('根节点收整棵树，兄弟子树不受影响', () => {
    expect(collectSubtreeIds(nodes, 'd1').sort()).toEqual(['d1', 'p1', 'p2', 't1', 't2']);
    expect(collectSubtreeIds(nodes, 't2')).toEqual(['t2']);
  });

  it('父子互指的坏数据不会转圈转死', () => {
    const cyclic = [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
    ];

    expect(collectSubtreeIds(cyclic, 'a').sort()).toEqual(['a', 'b']);
  });
});
