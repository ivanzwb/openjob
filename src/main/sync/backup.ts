import { existsSync, mkdirSync, readdirSync, rmSync, statSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeDb, getDb, getRawDb } from '../db';
import { getAppPaths } from '../paths';

export interface BackupInfo {
  file: string;
  sizeBytes: number;
  createdAt: number;
  reason: string;
}

const PREFIX = 'openjob-';

function backupsDir(): string {
  const { backupsDir: dir } = getAppPaths();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function parseName(file: string): { createdAt: number; reason: string } | null {
  // openjob-<epochMs>-<reason>.db
  const m = /^openjob-(\d+)-([a-zA-Z0-9_]+)\.db$/.exec(file);
  if (!m) return null;
  return { createdAt: Number(m[1]), reason: m[2] };
}

/**
 * 整库快照。
 *
 * 用 VACUUM INTO 而不是复制 .db 文件：WAL 模式下未 checkpoint 的事务还在
 * -wal 里，直接拷主文件会得到一个缺了最近写入的旧状态。VACUUM INTO 由
 * SQLite 自己保证一致性，产出的也是已整理、无 WAL 的单文件。
 */
export function createBackup(reason: string): BackupInfo {
  const safeReason = reason.replace(/[^a-zA-Z0-9_]/g, '') || 'manual';
  const createdAt = Date.now();
  const file = `${PREFIX}${createdAt}-${safeReason}.db`;
  const target = join(backupsDir(), file);

  // VACUUM INTO 要求目标不存在
  if (existsSync(target)) rmSync(target);

  // better-sqlite3 不支持参数化 VACUUM INTO，只能拼接；
  // 文件名由本函数生成且已过滤，不存在注入面。
  getRawDb().exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

  return { file, sizeBytes: statSync(target).size, createdAt, reason: safeReason };
}

export function listBackups(): BackupInfo[] {
  const dir = backupsDir();
  return readdirSync(dir)
    .map((file) => {
      const meta = parseName(file);
      if (!meta) return null;
      try {
        return { file, sizeBytes: statSync(join(dir, file)).size, ...meta };
      } catch {
        return null;
      }
    })
    .filter((b): b is BackupInfo => b !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 回退到某个快照。
 *
 * 还原前会先给当前库做一份快照，否则回退本身就是一次不可逆操作——
 * 用户选错了快照就再也回不到现场。
 */
export function restoreBackup(file: string): void {
  if (!parseName(file)) throw new Error(`非法的备份文件名：${file}`);

  const source = join(backupsDir(), file);
  if (!existsSync(source)) throw new Error(`备份不存在：${file}`);

  // 回退前的现场也留一份
  createBackup('prerestore');

  const { dbFile } = getAppPaths();
  closeDb();

  copyFileSync(source, dbFile);

  // 旧库的 -wal / -shm 必须清掉。它们属于被覆盖掉的那个数据库，
  // 留在原地会让 SQLite 试图把不属于这个文件的事务重放进来。
  for (const suffix of ['-wal', '-shm']) {
    const stale = `${dbFile}${suffix}`;
    if (existsSync(stale)) rmSync(stale);
  }

  // 重新打开，顺带跑一遍迁移与触发器安装
  getDb();
}

/** 只保留最近若干份，避免快照把磁盘吃满 */
export function pruneBackups(keep = 10): number {
  const dir = backupsDir();
  const stale = listBackups().slice(keep);
  for (const b of stale) {
    try {
      rmSync(join(dir, b.file));
    } catch {
      // 文件被占用时跳过，下次启动再清
    }
  }
  return stale.length;
}
