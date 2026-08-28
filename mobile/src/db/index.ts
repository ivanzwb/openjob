import * as Crypto from 'expo-crypto';
import { openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite';
import type { FieldOverwrite, PairingPayload } from '@shared/sync';
import { planMerge } from '@shared/syncMerge';
import { pendingMigrationIndices, runMigrations, userTableCount } from './migrate';
import { backfillRowVersions, installSyncTriggers } from '../sync/triggers';
import { getDeviceIdentity } from '../sync/identity';
import { collectChangeSet, collectFullChangeSet } from '../sync/collect';
import { applyAutoChanges } from '../sync/apply';
import {
  createBackup,
  createPresyncBackup,
  deleteBackup,
  listBackups,
  overwriteDatabaseWith,
  pruneBackups,
  type BackupInfo,
} from '../sync/backup';
import {
  buildRepoFileSkipMessage,
  canApplyRepoFileSync,
  estimateRepoFileBytes,
  getFreeDiskBytes,
  partitionRepoFileChanges,
} from '../sync/repoFileStorage';
import { exchangeWithDesktop, pairWithDesktop } from '../sync/client';
import { setPeerCreds } from '../remote/rpc';
import { hydrateAppSettingsFromDb } from '../config/settings';
import { ensureCriticalSchema } from './schemaEnsure';

interface PeerRow {
  device_id: string;
  display_name: string;
  platform: string;
  shared_key: string;
  last_address: string | null;
  last_local_seq: number;
  last_remote_seq: number;
  last_sync_at: number | null;
  last_full_sync_at: number | null;
  paired_at: number;
}

let raw: SQLiteDatabase | null = null;

/**
 * 升级到带新迁移的版本时，动 schema 之前先留一份现场。
 *
 * 迁移是唯一会不可逆改动既有数据的动作。单条迁移现在是原子的，但一次跨版本
 * 升级要跑一串，跑到第三条挂掉时前两条已经生效了，只有快照能整体退回去。
 * 挂在「打开数据库」而不是「装 APK」上——不管新版本是应用内更新、侧载还是
 * 本地构建装上来的，schema 真正要变的那一刻都在这里。
 *
 * 快照做不出来就不迁移：让用户腾出空间再进来，比在没有退路的情况下改库好。
 */
function backupBeforeMigrations(sqlite: SQLiteDatabase): void {
  if (userTableCount(sqlite) === 0) return; // 新库，没有可丢的东西
  if (pendingMigrationIndices(sqlite).length === 0) return; // schema 没有变化

  if (!createBackup(sqlite, 'premigrate')) {
    throw new Error(
      '这个版本要升级数据库结构，升级前需要先留一份整库快照，但手机存储空间不够。' +
        '请清出一些空间后重新打开应用——数据本身还没有被改动。',
    );
  }
  pruneBackups();
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
  backupBeforeMigrations(raw);
  runMigrations(raw);
  ensureCriticalSchema(raw);
  const identity = await getDeviceIdentity(raw);
  installSyncTriggers(raw, identity.deviceId);
  // 存量库补行版本，只在第一次跑到时生效
  backfillRowVersions(raw);

  raw.runSync(
    `INSERT INTO sync_meta (key, value) VALUES ('writeAs', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    identity.deviceId,
  );
  loadPeerCreds(raw);
  await hydrateAppSettingsFromDb(raw);

  // 启动时清一次。清理原本只挂在「新建了快照」之后，但按天保留和总量上限都是
  // 随时间过期的：同步节流后可能好几天不新建快照，过期文件就一直躺在那儿。
  try {
    pruneBackups();
  } catch {
    // 清理失败不该拦住启动
  }

  return raw;
}

export function isPaired(): boolean {
  if (!raw) return false;
  return Boolean(raw.getFirstSync(`SELECT 1 FROM sync_peer LIMIT 1`));
}

/** 自动同步开关（默认开）：凭据与会话之外的本机偏好，跟随数据库迁移，不入同步范围 */
export function getAutoSync(): boolean {
  if (!raw) return true;
  const row = raw.getFirstSync<{ value: string }>(`SELECT value FROM sync_meta WHERE key = 'autoSync'`);
  return row ? row.value === '1' : true;
}

export function setAutoSync(on: boolean): void {
  const sqlite = getRawDb();
  sqlite.runSync(
    `INSERT INTO sync_meta (key, value) VALUES ('autoSync', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    on ? '1' : '0',
  );
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

  // 手机端只保留一个对端；切换桌面时清掉旧配对与水位线
  sqlite.runSync(`DELETE FROM sync_peer`);

  sqlite.runSync(
    `INSERT INTO sync_peer (
      device_id, display_name, platform, shared_key, last_address,
      last_local_seq, last_remote_seq, last_sync_at, paired_at
    ) VALUES (?, ?, ?, ?, ?, 0, 0, NULL, ?)`,
    payload.deviceId,
    payload.displayName,
    'desktop',
    result.sharedKey,
    baseUrl,
    now,
  );

  setPeerCreds({ baseUrl, sharedKey: result.sharedKey, deviceId: identity.deviceId });
}

export function unpairDesktop(): void {
  const sqlite = getRawDb();
  sqlite.runSync(`DELETE FROM sync_peer`);
  setPeerCreds(null);
}

function setSyncMeta(sqlite: SQLiteDatabase, key: string, value: string): void {
  sqlite.runSync(
    `INSERT INTO sync_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    value,
  );
}

function clearRepoFileSyncNotice(sqlite: SQLiteDatabase): void {
  setSyncMeta(sqlite, 'repoFileSyncSkipped', '0');
  setSyncMeta(sqlite, 'repoFileSyncMessage', '');
  setSyncMeta(sqlite, 'repoFilePendingBytes', '0');
}

function persistRepoFileSyncSkipped(
  sqlite: SQLiteDatabase,
  neededBytes: number,
  freeBytes: number,
): string {
  const message = buildRepoFileSkipMessage(neededBytes, freeBytes);
  setSyncMeta(sqlite, 'repoFileSyncSkipped', '1');
  setSyncMeta(sqlite, 'repoFileSyncMessage', message);
  setSyncMeta(sqlite, 'repoFilePendingBytes', String(neededBytes));
  return message;
}

export function getRepoFileSyncNotice(): { skipped: boolean; message: string | null } {
  const sqlite = getRawDb();
  const skipped = sqlite.getFirstSync<{ value: string }>(
    `SELECT value FROM sync_meta WHERE key = 'repoFileSyncSkipped'`,
  );
  const message = sqlite.getFirstSync<{ value: string }>(
    `SELECT value FROM sync_meta WHERE key = 'repoFileSyncMessage'`,
  );
  return {
    skipped: skipped?.value === '1',
    message: message?.value ? message.value : null,
  };
}

function saveOverwrites(
  sqlite: SQLiteDatabase,
  runId: string,
  overwrites: FieldOverwrite[],
): void {
  for (const o of overwrites) {
    sqlite.runSync(
      `INSERT INTO sync_overwrite (
        id, run_id, table_name, row_id, field,
        local_value, remote_value, local_wall_ms, remote_wall_ms, kept_side
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      Crypto.randomUUID(),
      runId,
      o.table,
      o.rowId,
      o.field,
      JSON.stringify(o.localValue),
      JSON.stringify(o.remoteValue),
      o.localWallMs,
      o.remoteWallMs,
      o.keptSide,
    );
  }
}

/** 隔多久重做一次全表对账，兜住水位线本身出错的情况 */
const FULL_SYNC_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 这一轮该不该走全表快照。
 *
 * 刻意不做成用户选项：用户没有判断依据，多一个按钮只会让人不知道该按哪个。
 * 全量只在增量证明不可靠时才需要——
 * - 水位线为 0：首次配对或换了桌面端。本机那些"从别处同步进来、没进 oplog"
 *   的行只有全表快照推得出去，光靠增量会永久缺失。
 * - 上次同步失败：水位线可能停在半途，两端各自以为对方收到了。
 * - 太久没对过账：任何一次未预料的水位线错乱都能被这一步兜住。
 */
function needsFullSync(sqlite: SQLiteDatabase, peer: PeerRow): boolean {
  if (!peer.last_sync_at || peer.last_local_seq === 0 || peer.last_remote_seq === 0) return true;

  const lastRun = sqlite.getFirstSync<{ status: string; error_message: string | null }>(
    `SELECT status, error_message FROM sync_run ORDER BY started_at DESC LIMIT 1`,
  );
  // 'failed' 是回包已经拿到、落库落了一半，水位线可能停在半途。
  // 'not-applied' 是交换阶段就失败了，本机一个字节都没动，一般重发同一段增量就行；
  // 这里无脑升级反而危险：回包太大本身就是超时的主因，换成全量只会更大，于是每轮都
  // 超时、每轮都判定要全量，同步再也好不了。
  if (lastRun?.status === 'failed') return true;

  // 但「对端因为数据形状拒收」是例外。约束不满足和网络无关，重发一模一样的增量
  // 一百次也是同样的结果，同步会永久停在这里；只有全表对账能把对端缺的行带过去。
  // 外键这一类已经由 applyAutoChanges 就地跳过、不再抛错，剩下的（UNIQUE、
  // NOT NULL 等）仍然只能靠这一条兜住。必须按错误内容判定而不是按 status——
  // 否则超时也会被卷进来，那正是上面要避免的。
  if (/constraint failed/i.test(lastRun?.error_message ?? '')) return true;

  if (!peer.last_full_sync_at) return true;
  return Date.now() - peer.last_full_sync_at > FULL_SYNC_INTERVAL_MS;
}

export interface SyncOutcome {
  applied: number;
  /** 两端改了同一列、按更新时间取新而被覆盖掉的旧值数量 */
  overwrites: number;
  /** 本端因引用不存在的父行（父行已删除或从未存在）而跳过的变更数 */
  skipped: number;
  runId: string;
  /** 同步前的整库快照文件名；本轮无写入时为 null */
  backupFile: string | null;
  /** 本轮是否做了全表对账，仅用于说明耗时 */
  full: boolean;
  repoFileSkipped?: boolean;
  repoFileMessage?: string;
}

/**
 * 记一条失败的同步。
 *
 * 以前失败只更新界面上那行字，库里什么都不留，于是「上次失败就转全量」那条判断
 * 永远读到的是上一次成功——注释里承诺的自愈其实是死代码。顺带也让桌面端一条条
 * 成功记录、手机端却什么都没有这种对不上号的现象有了解释。
 *
 * status 分两种是给恢复策略用的，不是给人看的：
 * - 'not-applied'：交换阶段就失败了，本机数据没动过，下轮重发增量即可
 * - 'failed'：回包拿到了，落库过程中出的事，水位线可能停在半途，下轮要全量对账
 */
function recordFailedRun(
  sqlite: SQLiteDatabase,
  peerDeviceId: string,
  status: 'not-applied' | 'failed',
  error: unknown,
): void {
  const now = Date.now();
  sqlite.runSync(
    `INSERT INTO sync_run (
       id, peer_device_id, direction, status, backup_file,
       applied_count, overwrite_count, started_at, finished_at, error_message
     ) VALUES (?, ?, 'auto', ?, NULL, 0, 0, ?, ?, ?)`,
    Crypto.randomUUID(),
    peerDeviceId,
    status,
    now,
    now,
    error instanceof Error ? error.message : String(error),
  );
}

let inFlight: Promise<SyncOutcome> | null = null;

/**
 * 自动同步每 60 秒来一次，而一轮全表对账可以跑几分钟。没有这道闸，第二轮会在第一轮
 * 还没落库时就去读水位线，两轮各自以为自己是唯一的写入者。
 *
 * 代价是：正在跑的时候进来的调用会拿到当前这一轮的结果，而不是为它自己单独跑一轮。
 * 界面上很多地方是"写完一条就顺手同步一下"，这种调用会等到下一次轮询才真正推出去，
 * 最多晚一分钟。只是晚，不会丢——改动躺在本机 oplog 里，哪一轮都会带上。
 */
export function syncNow(): Promise<SyncOutcome> {
  if (inFlight) return inFlight;
  const run = (async () => {
    try {
      return await runSyncOnce();
    } finally {
      inFlight = null;
    }
  })();
  inFlight = run;
  return run;
}

async function runSyncOnce(): Promise<SyncOutcome> {
  const sqlite = await openDb();
  const identity = await getDeviceIdentity(sqlite);
  const peer = getPeer(sqlite);
  if (!peer?.last_address) throw new Error('尚未配对桌面端');

  // 水位线语义:last_local_seq = 本端 oplog 已发送给对方的水位;
  // last_remote_seq = 对端最近上报的 headSeq。
  // 全表对账扫描全表并请求对端也返回全表快照。
  const full = needsFullSync(sqlite, peer);
  const local = full
    ? collectFullChangeSet(sqlite, identity.deviceId)
    : collectChangeSet(sqlite, identity.deviceId, peer.last_local_seq);
  const response = await exchangeWithDesktop(
    peer.last_address,
    peer.shared_key,
    identity.deviceId,
    full ? 0 : peer.last_remote_seq,
    local,
    { full },
  ).catch((e: unknown) => {
    // 回包没拿到，本机数据没动过。记一笔，好让下一轮知道上次是断在网络上而不是落库上
    recordFailedRun(sqlite, peer.device_id, 'not-applied', e);
    throw e;
  });

  // 从这里往下都是本机写入。这一段出事就得记成 'failed'：水位线可能停在半途，
  // 下一轮必须全表对账才对得回来。
  try {
    const ctx = {
      clockOffsetMs: Date.now() - response.serverMs,
      isDeviceLocal: (t: string, c: string) => t === 'repo' && c === 'local_path',
      primaryKey: () => 'id',
      labelFor: (table: string, rowId: string, values: Record<string, unknown>) =>
        `${table}:${String(values.name ?? values.title ?? rowId)}`,
    };

    const plan = planMerge(local, response.changes, ctx);
    const { other, repoFile } = partitionRepoFileChanges(plan.auto);

    // 备份放在合并之后、落库之前：绝大多数同步其实无事可做，每 60 秒 VACUUM
    // 一遍整库（含几十 MB 的源码快照）纯属自残，而没有写入的同步也没什么可退的
    let backupFile: string | null = null;
    if (plan.auto.length > 0) {
      backupFile = createPresyncBackup(sqlite)?.file ?? null;
    }

    let appliedRemote = 0;
    let skippedLocal = 0;
    {
      const out = applyAutoChanges(sqlite, peer.device_id, other);
      appliedRemote += out.applied;
      // 会话已删、对端把它的子行按 insert 复活这一类变更落不了库，被跳过——
      // 同步照常收敛，计数交给 SyncOutcome 展示（父行已删除或从未存在）
      skippedLocal += out.skipped.length;
    }

    let repoFileSkipped = false;
    let repoFileMessage: string | undefined;
    if (repoFile.length > 0) {
      const neededBytes = estimateRepoFileBytes(repoFile, sqlite);
      const freeBytes = getFreeDiskBytes();
      if (canApplyRepoFileSync(neededBytes, freeBytes)) {
        const out = applyAutoChanges(sqlite, peer.device_id, repoFile);
        appliedRemote += out.applied;
        skippedLocal += out.skipped.length;
        clearRepoFileSyncNotice(sqlite);
      } else {
        repoFileSkipped = true;
        repoFileMessage = persistRepoFileSyncSkipped(sqlite, neededBytes, freeBytes);
      }
    }

    if (plan.auto.some((c) => c.table === 'app_setting')) {
      await hydrateAppSettingsFromDb(sqlite);
    }

    const runId = Crypto.randomUUID();
    const now = Date.now();
    sqlite.runSync(
      `INSERT INTO sync_run (
         id, peer_device_id, direction, status, backup_file,
         applied_count, overwrite_count, started_at, finished_at
       ) VALUES (?, ?, 'auto', 'success', ?, ?, ?, ?, ?)`,
      runId,
      peer.device_id,
      backupFile,
      appliedRemote,
      plan.overwrites.length,
      now,
      now,
    );
    if (plan.overwrites.length > 0) saveOverwrites(sqlite, runId, plan.overwrites);
    if (backupFile) pruneBackups();

    sqlite.runSync(
      `UPDATE sync_peer SET last_local_seq = ?, last_remote_seq = ?, last_sync_at = ?,
         last_full_sync_at = ?
       WHERE device_id = ?`,
      // 只能推到"真的发出去了"的那个位置，也就是采集时的 head，不能用此刻的 head：
      // 一轮同步要跑好几十秒，用户这期间的编辑也会进 oplog 并拿到更小的 seq，用此刻
      // 的 head 会把这些从没发出去的改动一并标成已发送，它们要等到下次全表对账才补回来
      local.headSeq,
      repoFileSkipped ? peer.last_remote_seq : response.changes.headSeq,
      now,
      // repo_file 没搬完就不算对完账，下一轮还要再来一次
      full && !repoFileSkipped ? now : peer.last_full_sync_at,
      peer.device_id,
    );

    return {
      applied: response.appliedCount + appliedRemote,
      skipped: skippedLocal + (response.skippedCount ?? 0),
      overwrites: plan.overwrites.length + response.overwriteCount,
      runId,
      backupFile,
      full,
      ...(repoFileSkipped ? { repoFileSkipped, repoFileMessage } : {}),
    };
  } catch (e) {
    recordFailedRun(sqlite, peer.device_id, 'failed', e);
    throw e;
  }
}

export function getPeerLabel(): string | null {
  const peer = getRawDb().getFirstSync<{ display_name: string; last_address: string | null }>(
    `SELECT display_name, last_address FROM sync_peer LIMIT 1`,
  );
  if (!peer?.last_address) return null;
  return `${peer.display_name} @ ${peer.last_address.replace(/^https?:\/\//, '')}`;
}

export interface OverwriteRow extends FieldOverwrite {
  id: string;
  runId: string;
  startedAt: number;
}

/**
 * 最近被自动覆盖掉的旧值。
 *
 * 不需要用户裁决，但得能看见：自动覆盖是同步链路上唯一会丢用户输入的地方，
 * 发现丢了东西时靠这份清单加上同步前的快照才能找回来。
 */
export function listRecentOverwrites(limit = 50): OverwriteRow[] {
  const rows = getRawDb().getAllSync<{
    id: string;
    run_id: string;
    table_name: string;
    row_id: string;
    field: string;
    local_value: string | null;
    remote_value: string | null;
    local_wall_ms: number;
    remote_wall_ms: number;
    kept_side: 'local' | 'remote';
    started_at: number;
  }>(
    `SELECT o.*, r.started_at FROM sync_overwrite o
     INNER JOIN sync_run r ON r.id = o.run_id
     ORDER BY r.started_at DESC, o.row_id
     LIMIT ?`,
    limit,
  );

  return rows.map((o) => ({
    id: o.id,
    runId: o.run_id,
    startedAt: o.started_at,
    table: o.table_name,
    rowId: o.row_id,
    field: o.field,
    localValue: o.local_value ? JSON.parse(o.local_value) : null,
    remoteValue: o.remote_value ? JSON.parse(o.remote_value) : null,
    localWallMs: o.local_wall_ms,
    remoteWallMs: o.remote_wall_ms,
    keptSide: o.kept_side,
    label: `${o.table_name}:${o.row_id}`,
  }));
}

export { listBackups, type BackupInfo };

/** 手动留一份现场，升级或大动作之前用 */
export function createManualBackup(): BackupInfo {
  const info = createBackup(getRawDb(), 'manual');
  if (!info) throw new Error('手机存储空间不够，这份快照没做成');
  pruneBackups();
  return info;
}

/**
 * 回退到某份快照。
 *
 * 还原前先给当前库留一份，否则回退本身就是不可逆操作——用户选错了快照就再
 * 也回不到现场。之后重新打开会顺带跑一遍迁移与触发器安装。
 */
export async function restoreFromBackup(file: string): Promise<void> {
  const sqlite = getRawDb();
  createBackup(sqlite, 'prerestore');
  sqlite.closeSync();
  raw = null;

  overwriteDatabaseWith(file);
  await openDb();
}

/** 删掉某份快照，腾出空间。不影响当前正在用的库。 */
export function deleteBackupFile(file: string): void {
  deleteBackup(file);
}
