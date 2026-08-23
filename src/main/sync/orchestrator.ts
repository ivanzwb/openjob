import { randomUUID } from 'node:crypto';
import { eq, desc } from 'drizzle-orm';
import type { ChangeSet, FieldOverwrite, SyncRunSummary } from '@shared/sync';
import { planMerge } from '@shared/syncMerge';
import { getDb, getRawDb, schema } from '../db';
import { applyAutoChanges } from './apply';
import { createPresyncBackup, pruneBackups } from './backup';
import { collectChangeSet, collectFullChangeSet, currentHeadSeq } from './collect';
import { getDeviceIdentity } from './identity';
import { buildMergeContext } from './labels';
import { getPeer, newRunId, updatePeerWatermarks } from './pairing';

export interface ExchangeInput {
  peerDeviceId: string;
  remote: ChangeSet;
  /**
   * 对端自己报的水位线：它已经收到的本端 oplog 位置。
   *
   * 参与合并的本端变更集必须按这个数取，不能用本端存的 peer.lastLocalSeq。后者是
   * 在回包发出之前就推到 head 的，一旦那一轮的回包没送达（手机端超时掐断就是），
   * 它就变成了一句没兑现的承诺：下一轮据此算出的本端变更集会漏掉对端其实没收到的
   * 那些行，planMerge 只认变更集、不查库，漏掉就等于"本机根本没有这一行"，于是
   * 对端更旧的值被无条件写入，本端较新的改动被静默覆盖。
   */
  sinceSeq: number;
  clockOffsetMs?: number;
  direction: 'auto' | 'manual';
  remoteAddress?: string;
  /**
   * 对端在做全表对账。本端也必须用全表快照参与合并——只拿 oplog 增量的话，
   * 本机那些"从别处同步进来、没进 oplog"的行会被当成本机根本没有这一行，
   * 于是无条件采纳对端的旧值。
   */
  full?: boolean;
}

export interface ExchangeResult {
  local: ChangeSet;
  appliedCount: number;
  overwriteCount: number;
  overwrites: FieldOverwrite[];
  runId: string;
  backupFile: string | null;
}

function rowToOverwrite(
  runId: string,
  o: FieldOverwrite,
): typeof schema.syncOverwrite.$inferInsert {
  return {
    id: randomUUID(),
    runId,
    tableName: o.table,
    rowId: o.rowId,
    field: o.field,
    localValue: o.localValue,
    remoteValue: o.remoteValue,
    localWallMs: o.localWallMs,
    remoteWallMs: o.remoteWallMs,
    keptSide: o.keptSide,
  };
}

function insertRun(runId: string, peerDeviceId: string, direction: 'auto' | 'manual'): void {
  getDb()
    .insert(schema.syncRun)
    .values({
      id: runId,
      peerDeviceId,
      direction,
      status: 'running',
      backupFile: null,
      appliedCount: 0,
      overwriteCount: 0,
      errorMessage: null,
      startedAt: Date.now(),
      finishedAt: null,
    })
    .run();
}

function finishRun(
  runId: string,
  status: 'success' | 'failed',
  appliedCount: number,
  overwriteCount: number,
  backupFile: string | null,
  errorMessage?: string,
): void {
  getDb()
    .update(schema.syncRun)
    .set({
      status,
      appliedCount,
      overwriteCount,
      backupFile,
      errorMessage: errorMessage ?? null,
      finishedAt: Date.now(),
    })
    .where(eq(schema.syncRun.id, runId))
    .run();
}

/**
 * 一次双向交换的核心流程：
 * 1. 提取本机变更（对端要求全表对账时用全表快照）
 * 2. 与对端变更做合并，同一列的分歧按更新时间取新的
 * 3. 真的有要写的东西时才做整库快照，然后落库
 * 4. 被覆盖掉的旧值记入 sync_overwrite 备查
 *
 * 备份放在合并之后、落库之前，是因为绝大多数同步其实无事可做：每 60 秒一次
 * 自动同步，每次都 VACUUM 一遍整库（含几十 MB 的源码快照）纯属自残，而没有
 * 写入的同步也没有什么需要回退。
 */
export function handleExchange(input: ExchangeInput): ExchangeResult {
  const raw = getRawDb();
  const identity = getDeviceIdentity(raw);
  const peer = getPeer(input.peerDeviceId);
  if (!peer) throw new Error('设备未配对');

  const runId = newRunId();
  insertRun(runId, input.peerDeviceId, input.direction);
  let backupFile: string | null = null;

  try {
    // 增量时按对端上报的水位起，不用本端存的 peer.lastLocalSeq（见 sinceSeq 的说明）
    const local = input.full
      ? collectFullChangeSet(raw, identity.deviceId)
      : collectChangeSet(raw, identity.deviceId, input.sinceSeq);
    const ctx = buildMergeContext(input.clockOffsetMs ?? 0);
    const plan = planMerge(local, input.remote, ctx);

    let appliedCount = 0;
    if (plan.auto.length > 0) {
      backupFile = createPresyncBackup().file;
      appliedCount = applyAutoChanges(raw, input.peerDeviceId, plan.auto);
    }

    if (plan.overwrites.length > 0) {
      const db = getDb();
      for (const o of plan.overwrites) {
        const stored =
          o.field === 'delete'
            ? {
                ...o,
                localValue:
                  local.rows.find((r) => r.table === o.table && r.rowId === o.rowId)?.values ??
                  o.localValue,
                remoteValue:
                  input.remote.rows.find((r) => r.table === o.table && r.rowId === o.rowId)
                    ?.values ?? o.remoteValue,
              }
            : o;
        db.insert(schema.syncOverwrite).values(rowToOverwrite(runId, stored)).run();
      }
    }

    updatePeerWatermarks(
      input.peerDeviceId,
      currentHeadSeq(raw),
      input.remote.headSeq,
      input.remoteAddress,
      input.full === true,
    );

    finishRun(runId, 'success', appliedCount, plan.overwrites.length, backupFile);
    if (backupFile) pruneBackups();

    return {
      local,
      appliedCount,
      overwriteCount: plan.overwrites.length,
      overwrites: plan.overwrites,
      runId,
      backupFile,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishRun(runId, 'failed', 0, 0, backupFile, message);
    throw err;
  }
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
      overwriteCount: run.overwriteCount,
      backupFile: run.backupFile,
      errorMessage: run.errorMessage,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    };
  });
}

/** 某次同步里被自动覆盖掉的旧值，供用户核对要不要从备份里捞回来 */
export function listRunOverwrites(runId: string): FieldOverwrite[] {
  return getDb()
    .select()
    .from(schema.syncOverwrite)
    .where(eq(schema.syncOverwrite.runId, runId))
    .all()
    .map((o) => ({
      table: o.tableName,
      rowId: o.rowId,
      field: o.field,
      localValue: o.localValue,
      remoteValue: o.remoteValue,
      localWallMs: o.localWallMs,
      remoteWallMs: o.remoteWallMs,
      keptSide: o.keptSide,
      label: `${o.tableName}:${o.rowId}`,
    }));
}

