import { existsSync, mkdirSync, readdirSync, rmSync, statSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { BackupInfo, BackupRetention } from '@shared/sync';
import { selectStaleBackups, shouldCreatePresyncBackup } from '@shared/sync';
import { closeDb, getDb, getRawDb } from '../db';
import { getAppPaths } from '../paths';

export type { BackupInfo };

const PREFIX = 'openjob-';
/** 桌面磁盘宽裕：最近 6 份 + 往回 14 天各一份；升级前、手动这类各留 3 份 */
const RETENTION: BackupRetention = {
  recentPresync: 6,
  presyncDays: 14,
  other: 3,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
};

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
export function createBackup(reason: string, handle?: Database.Database): BackupInfo {
  const safeReason = reason.replace(/[^a-zA-Z0-9_]/g, '') || 'manual';
  const createdAt = Date.now();
  const file = `${PREFIX}${createdAt}-${safeReason}.db`;
  const target = join(backupsDir(), file);

  // VACUUM INTO 要求目标不存在
  if (existsSync(target)) rmSync(target);

  // better-sqlite3 不支持参数化 VACUUM INTO，只能拼接；
  // 文件名由本函数生成且已过滤，不存在注入面。
  //
  // handle 显式传进来是给「迁移前快照」用的：那时候 getDb() 还在初始化中途，
  // 让它自己再去要一次连接就是在依赖初始化顺序的巧合。
  (handle ?? getRawDb()).exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

  return { file, sizeBytes: statSync(target).size, createdAt, reason: safeReason };
}

/**
 * 同步前快照，带节流。返回这轮同步可以回退到的那一份。
 *
 * 间隔内不新建、直接复用上一份：同步是每分钟一轮的，每轮都建快照的话配额
 * 全被同一分钟内的快照占满，回退窗口只有十分钟。复用意味着回退会多丢一点
 * 本机改动，但换来的是几天而不是几分钟的可恢复范围。
 */
export function createPresyncBackup(): BackupInfo {
  const latest = listBackups().find((b) => b.reason === 'presync') ?? null;
  if (!shouldCreatePresyncBackup(latest?.createdAt ?? null, Date.now())) {
    return latest as BackupInfo;
  }
  return createBackup('presync');
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

/** 清理旧快照，避免把磁盘吃满。保留策略见 selectStaleBackups */
export function pruneBackups(): number {
  const dir = backupsDir();
  let removed = 0;

  for (const b of selectStaleBackups(listBackups(), RETENTION)) {
    try {
      rmSync(join(dir, b.file));
      removed++;
    } catch {
      // 文件被占用时跳过，下次启动再清
    }
  }
  return removed;
}
