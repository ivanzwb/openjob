import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { getAppPaths } from '../paths';
import { createBackup } from '../sync/backup';
import { initSyncLayer } from '../sync/identity';
import * as schema from './schema';

export type Db = BetterSQLite3Database<typeof schema>;

let db: Db | null = null;
let raw: Database.Database | null = null;

function migrationsFolder(): string {
  // 打包后迁移文件走 extraResources，开发期直接读源码目录
  return app.isPackaged
    ? join(process.resourcesPath, 'migrations')
    : join(app.getAppPath(), 'src', 'main', 'db', 'migrations');
}

function userTableCount(handle: Database.Database): number {
  const row = handle
    .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .get() as { n: number };
  return row.n;
}

/** 还没跑过的迁移条数。读不出来时按 0 处理：宁可少备份一次，也别拦住启动 */
function pendingMigrationCount(handle: Database.Database): number {
  let total: number;
  try {
    const journal = JSON.parse(
      readFileSync(join(migrationsFolder(), 'meta', '_journal.json'), 'utf8'),
    ) as { entries?: unknown[] };
    total = journal.entries?.length ?? 0;
  } catch {
    return 0;
  }

  const hasLog = handle
    .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'`)
    .get() as { n: number };
  if (hasLog.n === 0) return total;

  const applied = handle.prepare(`SELECT count(*) AS n FROM __drizzle_migrations`).get() as {
    n: number;
  };
  return Math.max(0, total - applied.n);
}

/**
 * 升级到带新迁移的版本时，动 schema 之前先留一份现场。
 *
 * 迁移是唯一会不可逆地改动既有数据的动作（改列、改表、回填），一旦中途失败或
 * 结果不对，没有这份快照就真的回不去了。挂在「打开数据库」而不是「装更新」上：
 * 无论用户是走安装包、侧载 APK 还是本地重新构建，schema 真正要变的那一刻都在这里。
 *
 * 快照做不出来就不迁移。让用户腾出空间再打开，总比在没有退路的情况下改库好。
 */
function backupBeforeMigrations(handle: Database.Database): void {
  if (userTableCount(handle) === 0) return; // 空库，没有可丢的东西
  if (pendingMigrationCount(handle) === 0) return; // schema 没有变化

  try {
    createBackup('premigrate', handle);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `这个版本要升级数据库结构，升级前需要先留一份整库快照，但快照没做成：${message}。` +
        `请确认磁盘还有空间后重新打开应用——数据本身还没有被改动。`,
      { cause: err },
    );
  }
}

export function getDb(): Db {
  if (db) return db;

  const { dbFile } = getAppPaths();
  raw = new Database(dbFile);

  // WAL 让读写不互斥，长任务写入时 UI 查询不会被阻塞
  raw.pragma('journal_mode = WAL');
  // SQLite 默认不启用外键约束，schema 里的 onDelete 需要它才生效
  raw.pragma('foreign_keys = ON');

  db = drizzle(raw, { schema });
  backupBeforeMigrations(raw);
  migrate(db, { migrationsFolder: migrationsFolder() });

  import('../jobTarget/backfill').then(({ backfillJobTargetsFromCampaigns }) => {
    backfillJobTargetsFromCampaigns();
  }).catch(() => {});

  // 迁移之后才装：触发器要写 sync_oplog / sync_meta，这两张表由迁移创建
  initSyncLayer(raw);

  import('../config/syncMirror').then(({ ensureAppSettingsMirrored }) => ensureAppSettingsMirrored()).catch(() => {});

  // 启动时清一次。清理原本只挂在"新建了快照"之后，但按天保留和总量上限都是
  // 随时间过期的：同步节流后可能好几天不新建快照，过期文件就一直躺在那儿。
  import('../sync/backup')
    .then(({ pruneBackups }) => pruneBackups())
    .catch(() => {});

  return db;
}

/** 同步层要直接执行 VACUUM INTO、批量 apply 等 Drizzle 表达不了的语句 */
export function getRawDb(): Database.Database {
  getDb();
  if (!raw) throw new Error('数据库未初始化');
  return raw;
}

export function closeDb(): void {
  raw?.close();
  raw = null;
  db = null;
}

export function dbHealth(): { ok: boolean; tables: number; path: string } {
  const { dbFile } = getAppPaths();
  try {
    getDb();
    const row = raw
      ?.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'`)
      .get() as { n: number } | undefined;
    return { ok: true, tables: row?.n ?? 0, path: dbFile };
  } catch {
    return { ok: false, tables: 0, path: dbFile };
  }
}

export { schema };
