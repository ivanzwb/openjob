import * as Crypto from 'expo-crypto';
import { openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite';
import type { ConflictChoice, FieldConflict, PairingPayload } from '@shared/sync';
import { conflictKey, planMerge, resolutionsToChanges } from '@shared/syncMerge';
import { MIGRATIONS } from './migrations/bundle';
import { installSyncTriggers } from '../sync/triggers';
import { getDeviceIdentity } from '../sync/identity';
import { collectChangeSet, currentHeadSeq } from '../sync/collect';
import { applyAutoChanges } from '../sync/apply';
import { exchangeWithDesktop, pairWithDesktop } from '../sync/client';
import { setPeerCreds } from '../remote/rpc';

interface PeerRow {
  device_id: string;
  display_name: string;
  platform: string;
  shared_key: string;
  last_address: string | null;
  last_local_seq: number;
  last_remote_seq: number;
  last_sync_at: number | null;
  paired_at: number;
}

let raw: SQLiteDatabase | null = null;

const MIGRATION_LOG = '_migrations';

/**
 * 迁移日志表:记录已应用的迁移序号,避免每次启动都重放建表 SQL。
 * 对迁移已部分应用的旧数据库,语句级容错自动跳过已存在对象。
 */
function ensureMigrationLog(sqlite: SQLiteDatabase): void {
  sqlite.execSync(
    `CREATE TABLE IF NOT EXISTS ${MIGRATION_LOG} (idx INTEGER PRIMARY KEY, tag TEXT NOT NULL, applied_at INTEGER NOT NULL)`,
  );
}

function isAlreadyAppliedError(e: unknown): boolean {
  return /already exists|duplicate column name/i.test(String(e));
}

function runMigrations(sqlite: SQLiteDatabase): void {
  ensureMigrationLog(sqlite);
  const applied = new Set(
    sqlite.getAllSync<{ idx: number }>(`SELECT idx FROM ${MIGRATION_LOG}`).map((r) => r.idx),
  );
  for (let index = 0; index < MIGRATIONS.length; index++) {
    if (applied.has(index)) continue;
    for (const stmt of MIGRATIONS[index].split('--> statement-breakpoint')) {
      const trimmed = stmt.trim();
      if (!trimmed) continue;
      try {
        sqlite.execSync(trimmed);
      } catch (e) {
        // 迁移已部分应用的旧库:表和索引已存在时跳过,不中断启动
        if (isAlreadyAppliedError(e)) continue;
        throw e;
      }
    }
    sqlite.runSync(
      `INSERT INTO ${MIGRATION_LOG} (idx, tag, applied_at) VALUES (?, ?, ?)`,
      index,
      `migration_${index}`,
      Date.now(),
    );
  }
}

function loadPeerCreds(sqlite: SQLiteDatabase): void {
  const peer = sqlite.getFirstSync<PeerRow>(`SELECT * FROM sync_peer LIMIT 1`);
  if (!peer?.last_address) {
    setPeerCreds(null);
    return;
  }
  void getDeviceIdentity(sqlite).then((identity) => {
    setPeerCreds({
      baseUrl: peer.last_address!,
      sharedKey: peer.shared_key,
      deviceId: identity.deviceId,
    });
  });
}

export function getRawDb(): SQLiteDatabase {
  if (!raw) throw new Error('请先调用 openDb()');
  return raw;
}

export async function openDb(): Promise<SQLiteDatabase> {
  if (raw) return raw;

  raw = openDatabaseSync('openjob.db');
  raw.execSync('PRAGMA foreign_keys = ON;');
  runMigrations(raw);
  const identity = await getDeviceIdentity(raw);
  installSyncTriggers(raw, identity.deviceId);

  raw.runSync(
    `INSERT INTO sync_meta (key, value) VALUES ('writeAs', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    identity.deviceId,
  );
  loadPeerCreds(raw);
  return raw;
}

export function isPaired(): boolean {
  if (!raw) return false;
  return Boolean(raw.getFirstSync(`SELECT 1 FROM sync_peer LIMIT 1`));
}

function getPeer(sqlite: SQLiteDatabase): PeerRow | null {
  return sqlite.getFirstSync<PeerRow>(`SELECT * FROM sync_peer LIMIT 1`) ?? null;
}

export async function pairDesktop(payload: PairingPayload): Promise<void> {
  const sqlite = await openDb();
  const identity = await getDeviceIdentity(sqlite);
  const baseUrl = `http://${payload.host}:${payload.port}`;
  const result = await pairWithDesktop(payload, identity.deviceId, identity.displayName);
  const now = Date.now();

  sqlite.runSync(
    `INSERT INTO sync_peer (
      device_id, display_name, platform, shared_key, last_address,
      last_local_seq, last_remote_seq, last_sync_at, paired_at
    ) VALUES (?, ?, ?, ?, ?, 0, 0, NULL, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      display_name = excluded.display_name,
      shared_key = excluded.shared_key,
      last_address = excluded.last_address,
      paired_at = excluded.paired_at`,
    payload.deviceId,
    payload.displayName,
    'desktop',
    result.sharedKey,
    baseUrl,
    now,
  );

  setPeerCreds({ baseUrl, sharedKey: result.sharedKey, deviceId: identity.deviceId });
}

function saveConflicts(sqlite: SQLiteDatabase, runId: string, conflicts: FieldConflict[]): void {
  for (const c of conflicts) {
    sqlite.runSync(
      `INSERT INTO sync_conflict (
        id, run_id, table_name, row_id, field,
        local_value, remote_value, local_wall_ms, remote_wall_ms, resolution
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      Crypto.randomUUID(),
      runId,
      c.table,
      c.rowId,
      c.field,
      JSON.stringify(c.localValue),
      JSON.stringify(c.remoteValue),
      c.localWallMs,
      c.remoteWallMs,
    );
  }
}

export async function syncNow(): Promise<{
  applied: number;
  conflicts: number;
  status: string;
  runId: string | null;
}> {
  const sqlite = await openDb();
  const identity = await getDeviceIdentity(sqlite);
  const peer = getPeer(sqlite);
  if (!peer?.last_address) throw new Error('尚未配对桌面端');

  // 水位线语义:last_local_seq = 本端 oplog 已发送给对方的水位;
  // last_remote_seq = 对端最近上报的 headSeq。
  // 收集本机待发变更用 last_local_seq,请求对端增量用 last_remote_seq。
  const local = collectChangeSet(sqlite, identity.deviceId, peer.last_local_seq);
  const response = await exchangeWithDesktop(
    peer.last_address,
    peer.shared_key,
    identity.deviceId,
    peer.last_remote_seq,
    local,
  );

  const ctx = {
    clockOffsetMs: Date.now() - response.serverMs,
    isDeviceLocal: (t: string, c: string) =>
      t === 'repo' && ['local_path', 'status', 'indexed_at'].includes(c),
    primaryKey: () => 'id',
    labelFor: (table: string, rowId: string, values: Record<string, unknown>) =>
      `${table}:${String(values.name ?? values.title ?? rowId)}`,
  };

  const plan = planMerge(local, response.changes, ctx);
  const appliedRemote = applyAutoChanges(sqlite, peer.device_id, plan.auto);

  const runId = Crypto.randomUUID();
  if (plan.conflicts.length > 0) {
    sqlite.runSync(
      `INSERT INTO sync_run (id, peer_device_id, direction, status, applied_count, conflict_count, started_at, finished_at)
       VALUES (?, ?, 'auto', 'conflict', ?, ?, ?, ?)`,
      runId,
      peer.device_id,
      appliedRemote,
      plan.conflicts.length,
      Date.now(),
      Date.now(),
    );
    saveConflicts(sqlite, runId, plan.conflicts);
  }

  sqlite.runSync(
    `UPDATE sync_peer SET last_local_seq = ?, last_remote_seq = ?, last_sync_at = ?
     WHERE device_id = ?`,
    currentHeadSeq(sqlite),
    response.changes.headSeq,
    Date.now(),
    peer.device_id,
  );

  const conflictCount = plan.conflicts.length + response.conflictCount;
  return {
    applied: response.appliedCount + appliedRemote,
    conflicts: conflictCount,
    status: conflictCount > 0 ? 'conflict' : 'success',
    runId: plan.conflicts.length > 0 ? runId : null,
  };
}

export interface PendingConflictRow extends FieldConflict {
  id: string;
  runId: string;
}

export function getPeerLabel(): string | null {
  const peer = getRawDb().getFirstSync<{ display_name: string; last_address: string | null }>(
    `SELECT display_name, last_address FROM sync_peer LIMIT 1`,
  );
  if (!peer?.last_address) return null;
  return `${peer.display_name} @ ${peer.last_address.replace(/^https?:\/\//, '')}`;
}

export function listPendingConflicts(): FieldConflict[] {
  return listPendingConflictRows();
}

export function listPendingConflictRows(): PendingConflictRow[] {
  const sqlite = getRawDb();
  const rows = sqlite.getAllSync<{
    id: string;
    table_name: string;
    row_id: string;
    field: string;
    local_value: string | null;
    remote_value: string | null;
    local_wall_ms: number;
    remote_wall_ms: number;
    run_id: string;
  }>(
    `SELECT c.* FROM sync_conflict c
     INNER JOIN sync_run r ON r.id = c.run_id
     WHERE c.resolution = 'pending'
     ORDER BY c.row_id`,
  );

  return rows.map((c) => ({
    id: c.id,
    runId: c.run_id,
    table: c.table_name,
    rowId: c.row_id,
    field: c.field,
    localValue: c.local_value ? JSON.parse(c.local_value) : null,
    remoteValue: c.remote_value ? JSON.parse(c.remote_value) : null,
    localWallMs: c.local_wall_ms,
    remoteWallMs: c.remote_wall_ms,
    label: `${c.table_name}:${c.row_id}`,
  }));
}

export async function resolveConflicts(
  runId: string,
  choices: Array<{ table: string; rowId: string; field: string; choice: ConflictChoice }>,
): Promise<void> {
  const sqlite = getRawDb();
  const peer = getPeer(sqlite);
  if (!peer) throw new Error('未配对');

  const pending = sqlite.getAllSync<{
    id: string;
    table_name: string;
    row_id: string;
    field: string;
    local_value: string | null;
    remote_value: string | null;
    remote_wall_ms: number;
  }>(`SELECT * FROM sync_conflict WHERE run_id = ? AND resolution = 'pending'`, runId);

  const choiceMap = new Map<string, ConflictChoice>();
  for (const c of choices) {
    choiceMap.set(`${c.table}\u0000${c.rowId}\u0000${c.field}`, c.choice);
  }

  const fieldConflicts: FieldConflict[] = pending.map((c) => ({
    table: c.table_name,
    rowId: c.row_id,
    field: c.field,
    localValue: c.local_value ? JSON.parse(c.local_value) : null,
    remoteValue: c.remote_value ? JSON.parse(c.remote_value) : null,
    localWallMs: 0,
    remoteWallMs: c.remote_wall_ms,
    label: `${c.table_name}:${c.row_id}`,
  }));

  const remoteRows = new Map<string, { table: string; rowId: string; values: Record<string, unknown>; wallMs: number }>();
  const remoteTombstones: Array<{ table: string; rowId: string; wallMs: number }> = [];

  for (const c of pending) {
    const choice = choiceMap.get(`${c.table_name}\u0000${c.row_id}\u0000${c.field}`) ?? 'local';
    if (choice !== 'remote') continue;
    const k = `${c.table_name}\u0000${c.row_id}`;
    if (c.field === 'delete') {
      const remoteVal = c.remote_value ? JSON.parse(c.remote_value) : null;
      if (remoteVal && typeof remoteVal === 'object') {
        remoteRows.set(k, {
          table: c.table_name,
          rowId: c.row_id,
          values: remoteVal as Record<string, unknown>,
          wallMs: c.remote_wall_ms,
        });
      } else {
        remoteTombstones.push({ table: c.table_name, rowId: c.row_id, wallMs: c.remote_wall_ms });
      }
      continue;
    }
    const existing = remoteRows.get(k);
    if (existing) {
      existing.values[c.field] = c.remote_value ? JSON.parse(c.remote_value) : null;
    } else {
      remoteRows.set(k, {
        table: c.table_name,
        rowId: c.row_id,
        values: { [c.field]: c.remote_value ? JSON.parse(c.remote_value) : null },
        wallMs: c.remote_wall_ms,
      });
    }
  }

  const remote = {
    deviceId: peer.device_id,
    headSeq: 0,
    rows: [...remoteRows.values()].map((r) => ({
      table: r.table,
      rowId: r.rowId,
      values: r.values,
      changedFields: null,
      wallMs: r.wallMs,
    })),
    tombstones: remoteTombstones,
  };

  const changes = resolutionsToChanges(fieldConflicts, choiceMap, remote);
  applyAutoChanges(sqlite, peer.device_id, changes);

  for (const c of pending) {
    const choice = choiceMap.get(`${c.table_name}\u0000${c.row_id}\u0000${c.field}`) ?? 'local';
    sqlite.runSync(`UPDATE sync_conflict SET resolution = ? WHERE id = ?`, choice, c.id);
  }
  sqlite.runSync(`UPDATE sync_run SET status = 'success', finished_at = ? WHERE id = ?`, Date.now(), runId);
}
