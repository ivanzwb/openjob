/**
 * 合并引擎单元测试（迁移自 scripts/smoke-sync-merge.ts）。
 *
 * 同步出错的代价是静默丢数据，重构 planMerge / resolutionsToChanges 后
 * 这里的每一条用例都是回归防线：npm test 直接跑。
 */
import { describe, expect, it } from 'vitest';
import { conflictKey, planMerge, resolutionsToChanges, type MergeContext } from './syncMerge';
import type { ChangeSet } from './sync';

const ctx: MergeContext = {
  clockOffsetMs: 0,
  isDeviceLocal: (t, c) => t === 'repo' && ['local_path', 'status', 'indexed_at'].includes(c),
  primaryKey: () => 'id',
  labelFor: (t, id, v) => `${t}:${(v.name as string) ?? id}`,
};

function cs(deviceId: string, rows: ChangeSet['rows'], tombstones: ChangeSet['tombstones'] = []): ChangeSet {
  return { deviceId, headSeq: 1, rows, tombstones };
}

describe('planMerge 基本规则', () => {
  it('本机未改动，对端有改动 -> 自动采纳', () => {
    const p = planMerge(
      cs('A', []),
      cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done' }, changedFields: ['status'], wallMs: 100 }]),
      ctx,
    );
    expect(p.conflicts).toHaveLength(0);
    expect(p.auto).toHaveLength(1);
    expect(p.auto[0]).toMatchObject({ kind: 'insert' });
  });

  it('两端改了同一行的不同列 -> 自动合并', () => {
    const p = planMerge(
      cs('A', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done', order_idx: 3 }, changedFields: ['status'], wallMs: 100 }]),
      cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'pending', order_idx: 7 }, changedFields: ['order_idx'], wallMs: 120 }]),
      ctx,
    );
    expect(p.conflicts).toHaveLength(0);
    expect(p.auto).toHaveLength(1);
    expect(p.auto[0]).toMatchObject({ kind: 'patch', values: { order_idx: 7 } });
    expect(p.auto[0]!.values).not.toHaveProperty('status');
  });

  it('两端改了同一列且值不同 -> 冲突', () => {
    const p = planMerge(
      cs('A', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done' }, changedFields: ['status'], wallMs: 100 }]),
      cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'skipped' }, changedFields: ['status'], wallMs: 120 }]),
      ctx,
    );
    expect(p.conflicts).toHaveLength(1);
    expect(p.auto).toHaveLength(0);
    expect(p.conflicts[0]!.field).toBe('status');
    expect(p.conflicts[0]!.localValue).toBe('done');
    expect(p.conflicts[0]!.remoteValue).toBe('skipped');
  });

  it('两端改成了同一个值 -> 不算冲突', () => {
    const p = planMerge(
      cs('A', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done' }, changedFields: ['status'], wallMs: 100 }]),
      cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done' }, changedFields: ['status'], wallMs: 120 }]),
      ctx,
    );
    expect(p.conflicts).toHaveLength(0);
    expect(p.auto).toHaveLength(0);
  });
});

describe('planMerge 删除语义', () => {
  it('对端删除、本机未动 -> 自动删除', () => {
    const p = planMerge(cs('A', []), cs('B', [], [{ table: 'task', rowId: 't1', wallMs: 100 }]), ctx);
    expect(p.auto).toHaveLength(1);
    expect(p.auto[0]).toMatchObject({ kind: 'delete' });
    expect(p.conflicts).toHaveLength(0);
  });

  it('对端删除、本机修改 -> 冲突（标题可读）', () => {
    const p = planMerge(
      cs('A', [{ table: 'knowledge_node', rowId: 'n1', values: { id: 'n1', name: 'TCP', mastery: 0.9 }, changedFields: ['mastery'], wallMs: 100 }]),
      cs('B', [], [{ table: 'knowledge_node', rowId: 'n1', wallMs: 120 }]),
      ctx,
    );
    expect(p.conflicts).toHaveLength(1);
    expect(p.conflicts[0]!.field).toBe('delete');
    expect(p.conflicts[0]!.label).toBe('knowledge_node:TCP');
    expect(p.auto).toHaveLength(0);
  });

  it('本机删除、对端修改 -> 冲突', () => {
    const p = planMerge(
      cs('A', [], [{ table: 'knowledge_node', rowId: 'n1', wallMs: 100 }]),
      cs('B', [{ table: 'knowledge_node', rowId: 'n1', values: { id: 'n1', name: 'TLS' }, changedFields: ['name'], wallMs: 120 }]),
      ctx,
    );
    expect(p.conflicts).toHaveLength(1);
    expect(p.auto).toHaveLength(0);
  });

  it('两端都删了同一行 -> 天然一致，无操作', () => {
    const p = planMerge(
      cs('A', [], [{ table: 'task', rowId: 't1', wallMs: 100 }]),
      cs('B', [], [{ table: 'task', rowId: 't1', wallMs: 120 }]),
      ctx,
    );
    expect(p.conflicts).toHaveLength(0);
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

  it('两端只改了 deviceLocal 列（值不同）-> 不参与比对，无冲突无写入', () => {
    const p = planMerge(
      cs('A', [{ table: 'repo', rowId: 'r1', values: { id: 'r1', url: 'git@x', local_path: '/desktop/x' }, changedFields: ['local_path'], wallMs: 100 }]),
      cs('B', [{ table: 'repo', rowId: 'r1', values: { id: 'r1', url: 'git@x', local_path: '/phone/none' }, changedFields: ['local_path'], wallMs: 120 }]),
      ctx,
    );
    expect(p.conflicts).toHaveLength(0);
    expect(p.auto).toHaveLength(0);
  });

  it('两端改了同一非本机列且值不同 -> 冲突（deviceLocal 剔除不影响正常列）', () => {
    const p = planMerge(
      cs('A', [{ table: 'repo', rowId: 'r1', values: { id: 'r1', url: 'git@a', local_path: '/desktop/x' }, changedFields: ['url', 'local_path'], wallMs: 100 }]),
      cs('B', [{ table: 'repo', rowId: 'r1', values: { id: 'r1', url: 'git@b', local_path: '/phone/none' }, changedFields: ['url', 'local_path'], wallMs: 120 }]),
      ctx,
    );
    expect(p.conflicts).toHaveLength(1);
    expect(p.conflicts[0]!.field).toBe('url');
  });
});

describe('planMerge 时钟偏移', () => {
  it('对端时间被拉回本机时基', () => {
    const p = planMerge(
      cs('A', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done' }, changedFields: ['status'], wallMs: 1000 }]),
      cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'skipped' }, changedFields: ['status'], wallMs: 6000 }]),
      { ...ctx, clockOffsetMs: 5000 },
    );
    expect(p.conflicts[0]!.remoteWallMs).toBe(1000);
  });
});

describe('resolutionsToChanges', () => {
  it('用户选择对端后生成写入，只写选中的列', () => {
    const p = planMerge(
      cs('A', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done', est_minutes: 20 }, changedFields: ['status', 'est_minutes'], wallMs: 100 }]),
      cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'skipped', est_minutes: 45 }, changedFields: ['status', 'est_minutes'], wallMs: 120 }]),
      ctx,
    );
    expect(p.conflicts).toHaveLength(2);

    const choices = new Map<string, 'local' | 'remote'>();
    choices.set(conflictKey(p.conflicts[0]!), 'remote');
    choices.set(conflictKey(p.conflicts[1]!), 'local');

    const changes = resolutionsToChanges(
      p.conflicts,
      choices,
      cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'skipped', est_minutes: 45 }, changedFields: null, wallMs: 120 }]),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe('patch');
    expect(Object.keys(changes[0]!.values)).toHaveLength(1);
  });

  it('全部选本机 -> 不产生任何写入', () => {
    const p = planMerge(
      cs('A', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done' }, changedFields: ['status'], wallMs: 100 }]),
      cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'skipped' }, changedFields: ['status'], wallMs: 120 }]),
      ctx,
    );
    const choices = new Map<string, 'local' | 'remote'>();
    choices.set(conflictKey(p.conflicts[0]!), 'local');
    const changes = resolutionsToChanges(
      p.conflicts,
      choices,
      cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'skipped' }, changedFields: null, wallMs: 120 }]),
    );
    expect(changes).toHaveLength(0);
  });

  it('删除冲突选对端：对端删了 -> 生成删除', () => {
    const p = planMerge(
      cs('A', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done' }, changedFields: ['status'], wallMs: 100 }]),
      cs('B', [], [{ table: 'task', rowId: 't1', wallMs: 120 }]),
      ctx,
    );
    const choices = new Map<string, 'local' | 'remote'>();
    choices.set(conflictKey(p.conflicts[0]!), 'remote');
    const changes = resolutionsToChanges(
      p.conflicts,
      choices,
      cs('B', [], [{ table: 'task', rowId: 't1', wallMs: 120 }]),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'delete' });
  });

  it('删除冲突选对端：对端改过 -> 整行覆盖为对端值', () => {
    const p = planMerge(
      cs('A', [], [{ table: 'task', rowId: 't1', wallMs: 100 }]),
      cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'skipped' }, changedFields: ['status'], wallMs: 120 }]),
      ctx,
    );
    const choices = new Map<string, 'local' | 'remote'>();
    choices.set(conflictKey(p.conflicts[0]!), 'remote');
    const changes = resolutionsToChanges(
      p.conflicts,
      choices,
      cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'skipped' }, changedFields: null, wallMs: 120 }]),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'insert', values: { id: 't1', status: 'skipped' } });
  });

  it('conflictKey 是稳定标识', () => {
    const c = { table: 'task', rowId: 't1', field: 'status' };
    expect(conflictKey(c as never)).toBe('task\u0000t1\u0000status');
  });
});