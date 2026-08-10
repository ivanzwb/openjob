/**
 * 合并语义的回归防线：npm run smoke:sync
 *
 * 同步出错的代价是静默丢数据，而且往往要等用户发现某条笔记消失才暴露。
 * 改动 syncMerge 后务必跑一遍。
 */
import { planMerge, resolutionsToChanges, conflictKey } from '../src/shared/syncMerge';
import type { ChangeSet, MergeContext } from '../src/shared/sync';

const ctx: MergeContext = {
  clockOffsetMs: 0,
  isDeviceLocal: (t, c) => t === 'repo' && ['local_path', 'status', 'indexed_at'].includes(c),
  primaryKey: () => 'id',
  labelFor: (t, id, v) => `${t}:${(v.name as string) ?? id}`,
};

function cs(deviceId: string, rows: ChangeSet['rows'], tombstones: ChangeSet['tombstones'] = []): ChangeSet {
  return { deviceId, headSeq: 1, rows, tombstones };
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, detail !== undefined ? JSON.stringify(detail) : '');
  }
}

console.log('\n1. 本机未改动，对端有改动 -> 自动采纳');
{
  const p = planMerge(
    cs('A', []),
    cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done' }, changedFields: ['status'], wallMs: 100 }]),
    ctx,
  );
  check('无冲突', p.conflicts.length === 0);
  check('一条自动变更', p.auto.length === 1 && p.auto[0].kind === 'insert', p.auto);
}

console.log('\n2. 两端改了同一行的不同列 -> 自动合并');
{
  const p = planMerge(
    cs('A', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done', order_idx: 3 }, changedFields: ['status'], wallMs: 100 }]),
    cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'pending', order_idx: 7 }, changedFields: ['order_idx'], wallMs: 120 }]),
    ctx,
  );
  check('无冲突', p.conflicts.length === 0, p.conflicts);
  check('只 patch order_idx', p.auto.length === 1 && p.auto[0].kind === 'patch' && p.auto[0].values.order_idx === 7 && !('status' in p.auto[0].values), p.auto);
}

console.log('\n3. 两端改了同一列且值不同 -> 冲突');
{
  const p = planMerge(
    cs('A', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done' }, changedFields: ['status'], wallMs: 100 }]),
    cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'skipped' }, changedFields: ['status'], wallMs: 120 }]),
    ctx,
  );
  check('一处冲突', p.conflicts.length === 1, p.conflicts);
  check('无自动变更', p.auto.length === 0, p.auto);
  check('冲突在 status 上', p.conflicts[0]?.field === 'status');
  check('两侧值都带上了', p.conflicts[0]?.localValue === 'done' && p.conflicts[0]?.remoteValue === 'skipped');
}

console.log('\n4. 两端改成了同一个值 -> 不算冲突');
{
  const p = planMerge(
    cs('A', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done' }, changedFields: ['status'], wallMs: 100 }]),
    cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done' }, changedFields: ['status'], wallMs: 120 }]),
    ctx,
  );
  check('无冲突', p.conflicts.length === 0, p.conflicts);
  check('无多余写入', p.auto.length === 0, p.auto);
}

console.log('\n5. 对端删除、本机未动 -> 自动删除');
{
  const p = planMerge(cs('A', []), cs('B', [], [{ table: 'task', rowId: 't1', wallMs: 100 }]), ctx);
  check('自动删除', p.auto.length === 1 && p.auto[0].kind === 'delete', p.auto);
  check('无冲突', p.conflicts.length === 0);
}

console.log('\n6. 对端删除、本机修改 -> 冲突');
{
  const p = planMerge(
    cs('A', [{ table: 'knowledge_node', rowId: 'n1', values: { id: 'n1', name: 'TCP', mastery: 0.9 }, changedFields: ['mastery'], wallMs: 100 }]),
    cs('B', [], [{ table: 'knowledge_node', rowId: 'n1', wallMs: 120 }]),
    ctx,
  );
  check('一处冲突', p.conflicts.length === 1, p.conflicts);
  check('是行级删除冲突', p.conflicts[0]?.field === 'delete');
  check('标题可读', p.conflicts[0]?.label === 'knowledge_node:TCP', p.conflicts[0]?.label);
  check('未自动落库', p.auto.length === 0);
}

console.log('\n7. 本机删除、对端修改 -> 冲突');
{
  const p = planMerge(
    cs('A', [], [{ table: 'knowledge_node', rowId: 'n1', wallMs: 100 }]),
    cs('B', [{ table: 'knowledge_node', rowId: 'n1', values: { id: 'n1', name: 'TLS' }, changedFields: ['name'], wallMs: 120 }]),
    ctx,
  );
  check('一处冲突', p.conflicts.length === 1, p.conflicts);
  check('未自动落库', p.auto.length === 0, p.auto);
}

console.log('\n8. 本机专属列不接受对端值');
{
  const p = planMerge(
    cs('A', []),
    cs('B', [{ table: 'repo', rowId: 'r1', values: { id: 'r1', url: 'git@x', local_path: '/phone/none', status: 'pending' }, changedFields: null, wallMs: 100 }]),
    ctx,
  );
  const values = p.auto[0]?.values ?? {};
  check('url 被采纳', values.url === 'git@x');
  check('local_path 被剔除', !('local_path' in values), values);
  check('status 被剔除', !('status' in values), values);
}

console.log('\n9. 用户选择对端后生成写入');
{
  const p = planMerge(
    cs('A', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done', est_minutes: 20 }, changedFields: ['status', 'est_minutes'], wallMs: 100 }]),
    cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'skipped', est_minutes: 45 }, changedFields: ['status', 'est_minutes'], wallMs: 120 }]),
    ctx,
  );
  check('两处冲突', p.conflicts.length === 2, p.conflicts.map((c) => c.field));

  const choices = new Map<string, 'local' | 'remote'>();
  choices.set(conflictKey(p.conflicts[0]), 'remote');
  choices.set(conflictKey(p.conflicts[1]), 'local');

  const changes = resolutionsToChanges(p.conflicts, choices, cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'skipped', est_minutes: 45 }, changedFields: null, wallMs: 120 }]));
  check('合成一条 patch', changes.length === 1 && changes[0].kind === 'patch', changes);
  check('只写用户选了对端的那一列', Object.keys(changes[0]?.values ?? {}).length === 1, changes[0]?.values);
}

console.log('\n10. 时钟偏移被校正到本机时基');
{
  const p = planMerge(
    cs('A', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'done' }, changedFields: ['status'], wallMs: 1000 }]),
    cs('B', [{ table: 'task', rowId: 't1', values: { id: 't1', status: 'skipped' }, changedFields: ['status'], wallMs: 6000 }]),
    { ...ctx, clockOffsetMs: 5000 },
  );
  check('对端时间被拉回本机时基', p.conflicts[0]?.remoteWallMs === 1000, p.conflicts[0]?.remoteWallMs);
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
