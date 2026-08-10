import { join } from 'node:path';
import { app } from 'electron';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { getAppPaths } from '../paths';
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

export function getDb(): Db {
  if (db) return db;

  const { dbFile } = getAppPaths();
  raw = new Database(dbFile);

  // WAL 让读写不互斥，长任务写入时 UI 查询不会被阻塞
  raw.pragma('journal_mode = WAL');
  // SQLite 默认不启用外键约束，schema 里的 onDelete 需要它才生效
  raw.pragma('foreign_keys = ON');

  db = drizzle(raw, { schema });
  migrate(db, { migrationsFolder: migrationsFolder() });

  // 迁移之后才装：触发器要写 sync_oplog / sync_meta，这两张表由迁移创建
  initSyncLayer(raw);

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
