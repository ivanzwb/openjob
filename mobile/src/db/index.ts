import { openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite';
import type { PairingPayload } from '@shared/sync';
import { planMerge } from '@shared/syncMerge';
import { MIGRATIONS } from './migrations/bundle';
import { installSyncTriggers } from '../sync/triggers';
import { getDeviceIdentity } from '../sync/identity';
import { collectChangeSet, currentHeadSeq } from '../sync/collect';
import { applyAutoChanges } from '../sync/apply';
import { exchangeWithDesktop, pairWithDesktop } from '../sync/client';

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

function runMigrations(sqlite: SQLiteDatabase): void {
  for (const sql of MIGRATIONS) {
    for (const stmt of sql.split('--> statement-breakpoint')) {
      const trimmed = stmt.trim();
      if (trimmed) sqlite.execSync(trimmed);
    }
  }
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
  installSyncTriggers(raw);

  const identity = await getDeviceIdentity(raw);
  raw.runSync(
    `INSERT INTO sync_meta (key, value) VALUES ('writeAs', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    identity.deviceId,
  );

  return raw;
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
}

export async function syncNow(): Promise<{
  applied: number;
  conflicts: number;
  status: string;
}> {
  const sqlite = await openDb();
  const identity = await getDeviceIdentity(sqlite);
  const peer = getPeer(sqlite);
  if (!peer?.last_address) throw new Error('尚未配对桌面端');

  const local = collectChangeSet(sqlite, identity.deviceId, peer.last_remote_seq);
  const response = await exchangeWithDesktop(
    peer.last_address,
    peer.shared_key,
    identity.deviceId,
    peer.last_local_seq,
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

  sqlite.runSync(
    `UPDATE sync_peer SET last_local_seq = ?, last_remote_seq = ?, last_sync_at = ?
     WHERE device_id = ?`,
    currentHeadSeq(sqlite),
    response.changes.headSeq,
    Date.now(),
    peer.device_id,
  );

  return {
    applied: response.appliedCount + appliedRemote,
    conflicts: plan.conflicts.length + response.conflictCount,
    status: plan.conflicts.length > 0 || response.conflictCount > 0 ? 'conflict' : 'success',
  };
}
