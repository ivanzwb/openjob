import { Directory, File, Paths } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { BackupInfo, BackupRetention } from '@shared/sync';
import { selectStaleBackups, shouldCreatePresyncBackup } from '@shared/sync';

/**
 * 手机端的整库快照。
 *
 * 后写覆盖是自动的，用户没有机会拦下任何一次覆盖，所以"同步前留一份现场"
 * 是唯一的兜底。快照与桌面端那一份完全独立：各自存在自己机器上，各自回退，
 * 谁都不需要另一端在线。
 */

export type { BackupInfo };

const PREFIX = 'openjob-';
/** 手机存储紧张，留得比桌面端少：最近 3 份 + 往回 5 天各一份 */
const RETENTION: BackupRetention = {
  recentPresync: 3,
  presyncDays: 5,
  other: 2,
  maxTotalBytes: 1024 * 1024 * 1024,
};
/** 留给系统的余量，快照写不下时宁可不写也不要把手机撑满 */
const DISK_RESERVE_BYTES = 50 * 1024 * 1024;

function backupsDir(): Directory {
  const dir = new Directory(Paths.document, 'backups');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/** VACUUM INTO 要的是文件系统路径，Paths 给的是 file:// URI */
function fsPath(uri: string): string {
  return uri.startsWith('file://') ? decodeURI(uri.slice('file://'.length)) : uri;
}

function parseName(file: string): { createdAt: number; reason: string } | null {
  const m = /^openjob-(\d+)-([a-zA-Z0-9_]+)\.db$/.exec(file);
  if (!m) return null;
  return { createdAt: Number(m[1]), reason: m[2] };
}

export function listBackups(): BackupInfo[] {
  const dir = backupsDir();
  const items = dir.exists ? dir.list() : [];
  return items
    .map((item) => {
      const meta = parseName(item.name);
      if (!meta) return null;
      return { file: item.name, sizeBytes: item.size ?? 0, ...meta };
    })
    .filter((b): b is BackupInfo => b !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** 清理旧快照。保留策略见 selectStaleBackups */
export function pruneBackups(): number {
  const dir = backupsDir();
  let removed = 0;

  for (const b of selectStaleBackups(listBackups(), RETENTION)) {
    try {
      new File(dir, b.file).delete();
      removed++;
    } catch {
      // 文件被占用时跳过，下次同步再清
    }
  }
  return removed;
}

/**
 * 整库快照。
 *
 * 用 VACUUM INTO 而不是复制 .db 文件：WAL 模式下未 checkpoint 的事务还在
 * -wal 里，直接拷主文件会得到一个缺了最近写入的旧状态。
 *
 * 空间不够时返回 null 而不是抛错——同步本身比留快照重要，况且桌面端那一侧
 * 也会留一份。
 */
export function createBackup(sqlite: SQLiteDatabase, reason: string): BackupInfo | null {
  const safeReason = reason.replace(/[^a-zA-Z0-9_]/g, '') || 'manual';
  const createdAt = Date.now();
  const name = `${PREFIX}${createdAt}-${safeReason}.db`;
  const dir = backupsDir();
  const target = new File(dir, name);

  const dbFile = new File(new Directory(Paths.document, 'SQLite'), 'openjob.db');
  const needed = dbFile.exists ? (dbFile.size ?? 0) : 0;
  if (Paths.availableDiskSpace - DISK_RESERVE_BYTES < needed) return null;

  // VACUUM INTO 要求目标不存在
  if (target.exists) target.delete();

  // 文件名由本函数生成且已过滤，不存在注入面
  sqlite.execSync(`VACUUM INTO '${fsPath(target.uri).replace(/'/g, "''")}'`);

  return { file: name, sizeBytes: target.size ?? 0, createdAt, reason: safeReason };
}

/**
 * 同步前快照，带节流。返回这轮同步可以回退到的那一份，空间不足时为 null。
 *
 * 间隔内不新建、直接复用上一份：同步是每分钟一轮的，每轮都建快照的话配额
 * 全被同一分钟内的快照占满，回退窗口只有几分钟。复用意味着回退会多丢一点
 * 本机改动，但换来的是几天而不是几分钟的可恢复范围。
 */
export function createPresyncBackup(sqlite: SQLiteDatabase): BackupInfo | null {
  const latest = listBackups().find((b) => b.reason === 'presync') ?? null;
  if (!shouldCreatePresyncBackup(latest?.createdAt ?? null, Date.now())) return latest;
  return createBackup(sqlite, 'presync');
}

/**
 * 把某份快照覆盖回主库。调用方负责先关库、之后重新打开。
 *
 * 旧库的 -wal / -shm 必须清掉：它们属于被覆盖掉的那个数据库，留在原地会让
 * SQLite 试图把不属于这个文件的事务重放进来。
 */
export function overwriteDatabaseWith(file: string): void {
  if (!parseName(file)) throw new Error(`非法的备份文件名：${file}`);

  const source = new File(backupsDir(), file);
  if (!source.exists) throw new Error(`备份不存在：${file}`);

  const sqliteDir = new Directory(Paths.document, 'SQLite');
  for (const suffix of ['-wal', '-shm']) {
    const stale = new File(sqliteDir, `openjob.db${suffix}`);
    if (stale.exists) stale.delete();
  }

  const target = new File(sqliteDir, 'openjob.db');
  if (target.exists) target.delete();
  source.copy(target);
}
