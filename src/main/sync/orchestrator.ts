import { randomUUID } from 'node:crypto';
import { eq, desc } from 'drizzle-orm';
import type { ChangeSet, ConflictChoice, FieldConflict, SyncRunSummary } from '@shared/sync';
import { planMerge, resolutionsToChanges } from '@shared/syncMerge';
import { getDb, getRawDb, schema } from '../db';
import { applyAutoChanges } from './apply';
import { createBackup, pruneBackups } from './backup';
import { collectChangeSet, currentHeadSeq } from './collect';
import { getDeviceIdentity } from './identity';
import { buildMergeContext } from './labels';
import { getPeer, newRunId, updatePeerWatermarks } from './pairing';

export interface ExchangeInput {
  peerDeviceId: string;
  remote: ChangeSet;
  clockOffsetMs?: number;
  direction: 'auto' | 'manual';
  remoteAddress?: string;
}

export interface ExchangeResult {
  local: ChangeSet;
  appliedCount: number;
  conflictCount: number;
  conflicts: FieldConflict[];
  runId: string;
  backupFile: string | null;
  status: 'success' | 'conflict';
}

export interface ResolveInput {
  runId: string;
  choices: Array<{ table: string; rowId: string; field: string; choice: ConflictChoice }>;
}

function rowToConflict(
  runId: string,
  c: FieldConflict,
): typeof schema.syncConflict.$inferInsert {
  return {
    id: randomUUID(),
    runId,
    tableName: c.table,
    rowId: c.rowId,
    field: c.field,
    localValue: c.localValue,
    remoteValue: c.remoteValue,
    localWallMs: c.localWallMs,
    remoteWallMs: c.remoteWallMs,
    resolution: 'pending' as const,
  };
}

function insertRun(
  runId: string,
  peerDeviceId: string,
  direction: 'auto' | 'manual',
  backupFile: string | null,
): void {
  getDb()
    .insert(schema.syncRun)
    .values({
      id: runId,
      peerDeviceId,
      direction,
      status: 'running',
      backupFile,
      appliedCount: 0,
      conflictCount: 0,
      errorMessage: null,
      startedAt: Date.now(),
      finishedAt: null,
    })
    .run();
}

function finishRun(
  runId: string,
  status: 'success' | 'conflict' | 'failed',
  appliedCount: number,
  conflictCount: number,
  errorMessage?: string,
): void {
  getDb()
    .update(schema.syncRun)
    .set({
      status,
      appliedCount,
      conflictCount,
      errorMessage: errorMessage ?? null,
      finishedAt: Date.now(),
    })
    .where(eq(schema.syncRun.id, runId))
    .run();
}

/**
 * 一次双向交换的核心流程：
 * 1. 备份
 * 2. 提取本机变更
 * 3. 与对端变更做合并
 * 4. 自动变更落库
 * 5. 冲突写入 sync_conflict 等用户裁决
 */
export function handleExchange(input: ExchangeInput): ExchangeResult {
  const raw = getRawDb();
  const identity = getDeviceIdentity(raw);
  const peer = getPeer(input.peerDeviceId);
  if (!peer) throw new Error('设备未配对');

  const runId = newRunId();
  const backup = createBackup('presync');
  insertRun(runId, input.peerDeviceId, input.direction, backup.file);

  try {
    const local = collectChangeSet(raw, identity.deviceId, peer.lastRemoteSeq);
    const ctx = buildMergeContext(input.clockOffsetMs ?? 0);
    const plan = planMerge(local, input.remote, ctx);

    const appliedCount = applyAutoChanges(raw, input.peerDeviceId, plan.auto);

    if (plan.conflicts.length > 0) {
      const db = getDb();
      for (const c of plan.conflicts) {
        const stored =
          c.field === 'delete'
            ? {
                ...c,
                localValue:
                  local.rows.find((r) => r.table === c.table && r.rowId === c.rowId)?.values ??
                  c.localValue,
                remoteValue:
                  input.remote.rows.find((r) => r.table === c.table && r.rowId === c.rowId)
                    ?.values ?? c.remoteValue,
              }
            : c;
        db.insert(schema.syncConflict).values(rowToConflict(runId, stored)).run();
      }
    }

    const headLocal = currentHeadSeq(raw);
    updatePeerWatermarks(
      input.peerDeviceId,
      headLocal,
      input.remote.headSeq,
      input.remoteAddress,
    );

    const status = plan.conflicts.length > 0 ? 'conflict' : 'success';
    finishRun(runId, status, appliedCount, plan.conflicts.length);
    pruneBackups();

    return {
      local,
      appliedCount,
      conflictCount: plan.conflicts.length,
      conflicts: plan.conflicts,
      runId,
      backupFile: backup.file,
      status,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishRun(runId, 'failed', 0, 0, message);
    throw err;
  }
}

/** 用户裁决冲突后，把选定结果落库并关闭本次同步 */
export function resolveConflicts(input: ResolveInput): { applied: number } {
  const raw = getRawDb();
  const run = getDb().select().from(schema.syncRun).where(eq(schema.syncRun.id, input.runId)).get();
  if (!run) throw new Error('同步记录不存在');
  if (run.status !== 'conflict') throw new Error('该同步没有待处理冲突');

  const pending = getDb()
    .select()
    .from(schema.syncConflict)
    .where(eq(schema.syncConflict.runId, input.runId))
    .all()
    .filter((c) => c.resolution === 'pending');

  const choiceMap = new Map<string, ConflictChoice>();
  for (const c of input.choices) {
    choiceMap.set(`${c.table}\u0000${c.rowId}\u0000${c.field}`, c.choice);
  }

  const fieldConflicts: FieldConflict[] = pending.map((c) => ({
    table: c.tableName,
    rowId: c.rowId,
    field: c.field,
    localValue: c.localValue,
    remoteValue: c.remoteValue,
    localWallMs: c.localWallMs,
    remoteWallMs: c.remoteWallMs,
    label: `${c.tableName}:${c.rowId}`,
  }));

  const remoteRows = new Map<string, ChangeSet['rows'][number]>();
  const remoteTombstones: ChangeSet['tombstones'] = [];

  for (const c of pending) {
    const k = `${c.tableName}\u0000${c.rowId}`;
    const choice =
      choiceMap.get(`${c.tableName}\u0000${c.rowId}\u0000${c.field}`) ?? 'local';
    if (choice !== 'remote') continue;

    if (c.field === 'delete') {
      if (c.remoteValue && typeof c.remoteValue === 'object' && !Array.isArray(c.remoteValue)) {
        remoteRows.set(k, {
          table: c.tableName,
          rowId: c.rowId,
          values: c.remoteValue as Record<string, unknown>,
          changedFields: null,
          wallMs: c.remoteWallMs,
        });
      } else {
        remoteTombstones.push({
          table: c.tableName,
          rowId: c.rowId,
          wallMs: c.remoteWallMs,
        });
      }
      continue;
    }

    const existing = remoteRows.get(k);
    if (existing) {
      existing.values[c.field] = c.remoteValue;
    } else {
      remoteRows.set(k, {
        table: c.tableName,
        rowId: c.rowId,
        values: { [c.field]: c.remoteValue },
        changedFields: null,
        wallMs: c.remoteWallMs,
      });
    }
  }

  const remote: ChangeSet = {
    deviceId: run.peerDeviceId,
    headSeq: 0,
    rows: [...remoteRows.values()],
    tombstones: remoteTombstones,
  };

  const changes = resolutionsToChanges(fieldConflicts, choiceMap, remote);
  const applied = applyAutoChanges(raw, run.peerDeviceId, changes);

  const db = getDb();
  for (const c of pending) {
    const choice = choiceMap.get(`${c.tableName}\u0000${c.rowId}\u0000${c.field}`) ?? 'local';
    db.update(schema.syncConflict)
      .set({ resolution: choice })
      .where(eq(schema.syncConflict.id, c.id))
      .run();
  }

  finishRun(input.runId, 'success', run.appliedCount + applied, 0);
  return { applied };
}

export function listSyncRuns(limit = 20): SyncRunSummary[] {
  const db = getDb();
  const runs = db
    .select()
    .from(schema.syncRun)
    .orderBy(desc(schema.syncRun.startedAt))
    .limit(limit)
    .all();

  return runs.map((run) => {
    const peer = db
      .select()
      .from(schema.syncPeer)
      .where(eq(schema.syncPeer.deviceId, run.peerDeviceId))
      .get();
    return {
      id: run.id,
      peerDeviceId: run.peerDeviceId,
      peerName: peer?.displayName ?? run.peerDeviceId,
      direction: run.direction,
      status: run.status,
      appliedCount: run.appliedCount,
      conflictCount: run.conflictCount,
      backupFile: run.backupFile,
      errorMessage: run.errorMessage,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    };
  });
}

export function listPendingConflicts(runId: string): FieldConflict[] {
  const rows = getDb()
    .select()
    .from(schema.syncConflict)
    .where(eq(schema.syncConflict.runId, runId))
    .all()
    .filter((c) => c.resolution === 'pending');

  return rows.map((c) => ({
    table: c.tableName,
    rowId: c.rowId,
    field: c.field,
    localValue: c.localValue,
    remoteValue: c.remoteValue,
    localWallMs: c.localWallMs,
    remoteWallMs: c.remoteWallMs,
    label: `${c.tableName}:${c.rowId}`,
  }));
}

export function prepareOutbound(peerDeviceId: string): ChangeSet {
  const raw = getRawDb();
  const identity = getDeviceIdentity(raw);
  const peer = getPeer(peerDeviceId);
  if (!peer) throw new Error('设备未配对');
  return collectChangeSet(raw, identity.deviceId, peer.lastRemoteSeq);
}
