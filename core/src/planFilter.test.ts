/**
 * 守考点筛选对「超过三层的老数据」的向后兼容。
 *
 * 考点树的设计只有三层（domain → topic → point），但手机端曾经允许把 point 继续
 * 细化，用户库里已经存在四层、五层甚至更深的节点。那道门后来补上了，可既有数据
 * 一行不动，必须照原样显示。
 *
 * 筛选是这批数据最容易悄悄消失的地方：树只渲染 visibleNodeIds 里的节点，这两个
 * 函数一旦对深度有任何假设（比如只往下找固定层数），深层节点就会在筛选开启时从
 * 清单里不见——数据还在库里，用户以为丢了。所以这里按老数据的形状（point 挂在
 * point 下面）压到第六层来测。
 */
import { describe, expect, it } from 'vitest';
import type { TaskView } from './ipc';
import { nodeIdsForPlanFilter, nodeIdsForTreeFilter } from './planFilter';

/** domain → topic → point → point → point → point，后三层是老数据才有的形状 */
const DEEP_CHAIN = [
  { id: 'd1', parentId: null },
  { id: 't1', parentId: 'd1' },
  { id: 'p1', parentId: 't1' },
  { id: 'p2', parentId: 'p1' },
  { id: 'p3', parentId: 'p2' },
  { id: 'p4', parentId: 'p3' },
];

const task = (nodeId: string | null): TaskView => ({ nodeId }) as unknown as TaskView;

describe('考点筛选对超过三层的老数据', () => {
  it('命中最深一层时，整条祖先链都要留下，否则那一行没有父节点可挂', () => {
    const ids = nodeIdsForTreeFilter(DEEP_CHAIN, ['p4']);

    expect([...ids].sort()).toEqual(['d1', 'p1', 'p2', 'p3', 'p4', 't1']);
  });

  it('命中中间层时，它下面的深层后代一个都不能少', () => {
    const ids = nodeIdsForTreeFilter(DEEP_CHAIN, ['p1']);

    // 往上到根、往下到第六层，全在
    expect(ids.has('d1')).toBe(true);
    expect(ids.has('t1')).toBe(true);
    expect(ids.has('p2')).toBe(true);
    expect(ids.has('p3')).toBe(true);
    expect(ids.has('p4')).toBe(true);
  });

  it('日历筛选同样要带上深层后代，深层考点才点得开', () => {
    const ids = nodeIdsForPlanFilter(DEEP_CHAIN, [task('t1')]);

    expect([...ids].sort()).toEqual(['d1', 'p1', 'p2', 'p3', 'p4', 't1']);
  });

  it('没关联考点的任务不影响筛选结果', () => {
    expect(nodeIdsForPlanFilter(DEEP_CHAIN, [task(null)]).size).toBe(0);
  });

  it('祖先链断了的深层节点只收真实存在的行，不放幽灵 id 进去', () => {
    // 老数据里删过中间层就是这个形状：p3 的父亲 p2 已经不在了
    const orphaned = [
      { id: 'p3', parentId: 'p2' },
      { id: 'p4', parentId: 'p3' },
    ];

    const ids = nodeIdsForTreeFilter(orphaned, ['p4']);

    // p2 匹配不上任何节点，放进可见集合没有意义
    expect([...ids].sort()).toEqual(['p3', 'p4']);
  });
});
