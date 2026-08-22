/**
 * 合并引擎单元测试。
 *
 * 同步出错的代价是静默丢数据，重构 planMerge 后这里的每一条用例都是回归
 * 防线：npm test 直接跑。
 *
 * 最重要的一组是「收敛」：后写覆盖只有在两端独立算出同一个赢家时才成立，
 * 否则每轮同步各自覆盖对方，数据永远不一致。这个性质靠 describe('收敛')
 * 里的双向模拟守住。
 */
import { describe, expect, it } from 'vitest';
import { planMerge, type MergeContext } from './syncMerge';
import type { ChangeSet, MergePlan } from './sync';

const ctx: MergeContext = {
  clockOffsetMs: 0,
  isDeviceLocal: (t, c) => t === 'repo' && ['local_path', 'status', 'indexed_at'].includes(c),
  primaryKey: () => 'id',
  labelFor: (t, id, v) => `${t}:${(v.name as string) ?? id}`,
};

function cs(
  deviceId: string,
  rows: ChangeSet['rows'],
  tombstones: ChangeSet['tombstones'] = [],
): ChangeSet {
  return { deviceId, headSeq: 1, rows, tombstones };
}

describe('planMerge 列级合并', () => {
  it('本机未改动，对端有改动 -> 自动采纳', () => {
    const p = planMerge(
      cs('A', []),
      cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done' }, changedFields: ['status'], wallMs: 100 }]),
      ctx,
    );
    expect(p.overwrites).toHaveLength(0);
    expect(p.auto).toHaveLength(1);
    expect(p.auto[0]).toMatchObject({ kind: 'insert' });
  });

  it('两端改了同一行的不同列 -> 两边修改都保留，不算覆盖', () => {
    const p = planMerge(
      cs('A', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done', order_idx: 3 }, changedFields: ['status'], wallMs: 100 }]),
      cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'pending', order_idx: 7 }, changedFields: ['order_idx'], wallMs: 120 }]),
      ctx,
    );
    expect(p.overwrites).toHaveLength(0);
    expect(p.auto).toHaveLength(1);
    expect(p.auto[0]).toMatchObject({ kind: 'patch', values: { order_idx: 7 } });
    expect(p.auto[0]!.values).not.toHaveProperty('status');
  });

  it('两端改成了同一个值 -> 不算分歧', () => {
    const p = planMerge(
      cs('A', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done' }, changedFields: ['status'], wallMs: 100 }]),
      cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done' }, changedFields: ['status'], wallMs: 120 }]),
      ctx,
    );
    expect(p.overwrites).toHaveLength(0);
    expect(p.auto).toHaveLength(0);
  });
});

describe('planMerge 后写覆盖', () => {
  it('同一列值不同、对端更晚 -> 采纳对端并留痕', () => {
    const p = planMerge(
      cs('A', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done' }, changedFields: ['status'], wallMs: 100 }]),
      cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'skipped' }, changedFields: ['status'], wallMs: 120 }]),
      ctx,
    );
    expect(p.auto).toHaveLength(1);
    expect(p.auto[0]).toMatchObject({ kind: 'patch', values: { status: 'skipped' } });
    expect(p.overwrites).toHaveLength(1);
    expect(p.overwrites[0]).toMatchObject({
      field: 'status',
      localValue: 'done',
      remoteValue: 'skipped',
      keptSide: 'remote',
    });
  });

  it('同一列值不同、本机更晚 -> 保留本机，不写库但留痕', () => {
    const p = planMerge(
      cs('A', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done' }, changedFields: ['status'], wallMs: 200 }]),
      cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'skipped' }, changedFields: ['status'], wallMs: 120 }]),
      ctx,
    );
    expect(p.auto).toHaveLength(0);
    expect(p.overwrites).toHaveLength(1);
    expect(p.overwrites[0]).toMatchObject({ keptSide: 'local' });
  });

  it('时间完全相同 -> 按 deviceId 字典序定胜负', () => {
    const fromA = planMerge(
      cs('A', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done' }, changedFields: ['status'], wallMs: 100 }]),
      cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'skipped' }, changedFields: ['status'], wallMs: 100 }]),
      ctx,
    );
    // 'B' > 'A'，两端都选 B 那一侧
    expect(fromA.overwrites[0]).toMatchObject({ keptSide: 'remote' });

    const fromB = planMerge(
      cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'skipped' }, changedFields: ['status'], wallMs: 100 }]),
      cs('A', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done' }, changedFields: ['status'], wallMs: 100 }]),
      ctx,
    );
    expect(fromB.overwrites[0]).toMatchObject({ keptSide: 'local' });
  });

  it('全表快照（changedFields 为 null）也按时间取新，不会退化成整行乱覆盖', () => {
    const p = planMerge(
      cs('A', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done', est_minutes: 20 }, changedFields: null, wallMs: 300 }]),
      cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'skipped', est_minutes: 45 }, changedFields: null, wallMs: 120 }]),
      ctx,
    );
    expect(p.auto).toHaveLength(0);
    expect(p.overwrites.map((o) => o.field).sort()).toEqual(['est_minutes', 'status']);
    expect(p.overwrites.every((o) => o.keptSide === 'local')).toBe(true);
  });

  it('落库的变更带来源时间，不带本机当前时间', () => {
    const p = planMerge(
      cs('A', []),
      cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done' }, changedFields: null, wallMs: 100 }]),
      ctx,
    );
    expect(p.auto[0]!.wallMs).toBe(100);
  });

  it('合成行的版本时间取两端较晚的那个', () => {
    const p = planMerge(
      cs('A', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done', order_idx: 3 }, changedFields: ['status'], wallMs: 500 }]),
      cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done', order_idx: 7 }, changedFields: ['order_idx'], wallMs: 120 }]),
      ctx,
    );
    expect(p.auto[0]!.wallMs).toBe(500);
  });
});

describe('planMerge 删除语义', () => {
  it('对端删除、本机未动 -> 自动删除', () => {
    const p = planMerge(cs('A', []), cs('B', [], [{ table: 'task', rowId: 't1', wallMs: 100 }]), ctx);
    expect(p.auto).toHaveLength(1);
    expect(p.auto[0]).toMatchObject({ kind: 'delete' });
    expect(p.overwrites).toHaveLength(0);
  });

  it('对端删除更晚、本机修改更早 -> 删除生效', () => {
    const p = planMerge(
      cs('A', [{ table: 'knowledge_node', rowId: 'n1', values: { id: 'n1', name: 'TCP', mastery: 0.9 }, changedFields: ['mastery'], wallMs: 100 }]),
      cs('B', [], [{ table: 'knowledge_node', rowId: 'n1', wallMs: 120 }]),
      ctx,
    );
    expect(p.auto).toHaveLength(1);
    expect(p.auto[0]).toMatchObject({ kind: 'delete' });
    expect(p.overwrites[0]).toMatchObject({ field: 'delete', keptSide: 'remote', label: 'knowledge_node:TCP' });
  });

  it('本机修改更晚、对端删除更早 -> 保住这一行', () => {
    const p = planMerge(
      cs('A', [{ table: 'knowledge_node', rowId: 'n1', values: { id: 'n1', name: 'TCP' }, changedFields: ['name'], wallMs: 300 }]),
      cs('B', [], [{ table: 'knowledge_node', rowId: 'n1', wallMs: 120 }]),
      ctx,
    );
    expect(p.auto).toHaveLength(0);
    expect(p.overwrites[0]).toMatchObject({ keptSide: 'local' });
  });

  it('本机删除更早、对端修改更晚 -> 把行救回来', () => {
    const p = planMerge(
      cs('A', [], [{ table: 'knowledge_node', rowId: 'n1', wallMs: 100 }]),
      cs('B', [{ table: 'knowledge_node', rowId: 'n1', values: { id: 'n1', name: 'TLS' }, changedFields: ['name'], wallMs: 120 }]),
      ctx,
    );
    expect(p.auto).toHaveLength(1);
    expect(p.auto[0]).toMatchObject({ kind: 'insert', values: { id: 'n1', name: 'TLS' } });
    expect(p.overwrites[0]).toMatchObject({ keptSide: 'remote' });
  });

  it('两端都删了同一行 -> 天然一致，无操作', () => {
    const p = planMerge(
      cs('A', [], [{ table: 'task', rowId: 't1', wallMs: 100 }]),
      cs('B', [], [{ table: 'task', rowId: 't1', wallMs: 120 }]),
      ctx,
    );
    expect(p.overwrites).toHaveLength(0);
    expect(p.auto).toHaveLength(0);
  });
});

describe('planMerge 本机专属列', () => {
  it('对端新增的行中，deviceLocal 列被剔除', () => {
    const p = planMerge(
      cs('A', []),
      cs('B', [{ table: 'repo', rowId: 'r1', values: { id: 'r1', url: 'git@x', local_path: '/phone/none', status: 'pending' }, changedFields: null, wallMs: 100 }]),
      ctx,
    );
    const values = p.auto[0]?.values ?? {};
    expect(values.url).toBe('git@x');
    expect(values).not.toHaveProperty('local_path');
    expect(values).not.toHaveProperty('status');
  });

  it('两端只改了 deviceLocal 列（值不同）-> 不参与比对，无覆盖无写入', () => {
    const p = planMerge(
      cs('A', [{ table: 'repo', rowId: 'r1', values: { id: 'r1', url: 'git@x', local_path: '/desktop/x' }, changedFields: ['local_path'], wallMs: 100 }]),
      cs('B', [{ table: 'repo', rowId: 'r1', values: { id: 'r1', url: 'git@x', local_path: '/phone/none' }, changedFields: ['local_path'], wallMs: 120 }]),
      ctx,
    );
    expect(p.overwrites).toHaveLength(0);
    expect(p.auto).toHaveLength(0);
  });

  it('deviceLocal 剔除不影响正常列的覆盖判定', () => {
    const p = planMerge(
      cs('A', [{ table: 'repo', rowId: 'r1', values: { id: 'r1', url: 'git@a', local_path: '/desktop/x' }, changedFields: ['url', 'local_path'], wallMs: 100 }]),
      cs('B', [{ table: 'repo', rowId: 'r1', values: { id: 'r1', url: 'git@b', local_path: '/phone/none' }, changedFields: ['url', 'local_path'], wallMs: 120 }]),
      ctx,
    );
    expect(p.overwrites).toHaveLength(1);
    expect(p.overwrites[0]!.field).toBe('url');
    expect(p.auto[0]!.values).toEqual({ url: 'git@b' });
  });
});

describe('planMerge 时钟偏移', () => {
  it('对端时间被拉回本机时基后才比较', () => {
    const p = planMerge(
      cs('A', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done' }, changedFields: ['status'], wallMs: 1000 }]),
      cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'skipped' }, changedFields: ['status'], wallMs: 6000 }]),
      { ...ctx, clockOffsetMs: 5000 },
    );
    expect(p.overwrites[0]!.remoteWallMs).toBe(1000);
  });

  it('对端墙钟领先 5 秒但实际改得更早时，不会靠时钟差抢赢', () => {
    const p = planMerge(
      cs('A', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done' }, changedFields: ['status'], wallMs: 2000 }]),
      cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'skipped' }, changedFields: ['status'], wallMs: 6000 }]),
      { ...ctx, clockOffsetMs: 5000 },
    );
    expect(p.overwrites[0]).toMatchObject({ keptSide: 'local' });
    expect(p.auto).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 收敛：两端各自跑一遍合并后，数据必须一致
// ---------------------------------------------------------------------------

type Rows = Map<string, Record<string, unknown> | null>;

/** 把合并计划落到一个内存"库"上，null 表示该行已删除 */
function applyPlan(rows: Rows, plan: MergePlan): void {
  for (const change of plan.auto) {
    const k = `${change.table}\u0000${change.rowId}`;
    if (change.kind === 'delete') {
      rows.set(k, null);
    } else if (change.kind === 'insert') {
      rows.set(k, { ...change.values });
    } else {
      const existing = rows.get(k);
      rows.set(k, { ...(existing ?? {}), ...change.values });
    }
  }
}

/**
 * 模拟一次完整的双向同步：两端拿着对方的变更集各自合并一次。
 * 返回两端最终的行内容，调用方断言它们相等。
 *
 * 注意偏移量在两端是反号的：A 觉得 B 的钟快 5 秒，B 就觉得 A 的钟慢 5 秒。
 * 两边用同一个符号是错的，会让双方都判自己更晚，谁也不让谁。
 */
function syncBothWays(
  aState: Record<string, unknown> | null,
  bState: Record<string, unknown> | null,
  aChanges: ChangeSet,
  bChanges: ChangeSet,
  context: MergeContext = ctx,
): { a: Record<string, unknown> | null; b: Record<string, unknown> | null } {
  const k = 'task\u0000t1';
  const aRows: Rows = new Map([[k, aState]]);
  const bRows: Rows = new Map([[k, bState]]);

  applyPlan(aRows, planMerge(aChanges, bChanges, context));
  applyPlan(
    bRows,
    planMerge(bChanges, aChanges, { ...context, clockOffsetMs: -context.clockOffsetMs }),
  );

  return { a: aRows.get(k) ?? null, b: bRows.get(k) ?? null };
}

describe('收敛', () => {
  it('同一列改成不同值 -> 两端都落到更晚的那个值', () => {
    const { a, b } = syncBothWays(
      { id: 't1', status: 'done' },
      { id: 't1', status: 'skipped' },
      cs('A', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done' }, changedFields: ['status'], wallMs: 100 }]),
      cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'skipped' }, changedFields: ['status'], wallMs: 120 }]),
    );
    expect(a).toEqual(b);
    expect(a).toMatchObject({ status: 'skipped' });
  });

  it('时间相同 -> 两端仍落到同一个值，不会来回翻', () => {
    const { a, b } = syncBothWays(
      { id: 't1', status: 'done' },
      { id: 't1', status: 'skipped' },
      cs('A', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done' }, changedFields: ['status'], wallMs: 100 }]),
      cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'skipped' }, changedFields: ['status'], wallMs: 100 }]),
    );
    expect(a).toEqual(b);
  });

  it('改了不同列 -> 两端都拿到合并后的完整行，谁的修改都没丢', () => {
    const { a, b } = syncBothWays(
      { id: 't1', status: 'done', order_idx: 3 },
      { id: 't1', status: 'pending', order_idx: 7 },
      cs('A', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done', order_idx: 3 }, changedFields: ['status'], wallMs: 100 }]),
      cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'pending', order_idx: 7 }, changedFields: ['order_idx'], wallMs: 120 }]),
    );
    expect(a).toEqual(b);
    expect(a).toMatchObject({ status: 'done', order_idx: 7 });
  });

  it('一端删除、另一端修改 -> 两端对"这行还在不在"得出同一结论', () => {
    const deleteWins = syncBothWays(
      null,
      { id: 't1', status: 'skipped' },
      cs('A', [], [{ table: 'task', rowId: 't1', wallMs: 300 }]),
      cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'skipped' }, changedFields: ['status'], wallMs: 120 }]),
    );
    expect(deleteWins.a).toBeNull();
    expect(deleteWins.b).toBeNull();

    const editWins = syncBothWays(
      null,
      { id: 't1', status: 'skipped' },
      cs('A', [], [{ table: 'task', rowId: 't1', wallMs: 100 }]),
      cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'skipped' }, changedFields: ['status'], wallMs: 120 }]),
    );
    expect(editWins.a).toEqual(editWins.b);
    expect(editWins.a).toMatchObject({ status: 'skipped' });
  });

  it('时钟有偏移时也收敛', () => {
    const { a, b } = syncBothWays(
      { id: 't1', status: 'done' },
      { id: 't1', status: 'skipped' },
      cs('A', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done' }, changedFields: ['status'], wallMs: 2000 }]),
      cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'skipped' }, changedFields: ['status'], wallMs: 6000 }]),
      { ...ctx, clockOffsetMs: 5000 },
    );
    expect(a).toEqual(b);
    expect(a).toMatchObject({ status: 'done' });
  });
});
