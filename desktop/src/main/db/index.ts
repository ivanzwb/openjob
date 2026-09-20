import { join } from 'node:path';
import { app } from 'electron';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { getAppPaths } from '../paths';
import { createBackup } from '../sync/backup';
import { initSyncLayer } from '../sync/identity';
import { backfillPrePluginCampaignRuntime } from './backfill/pluginRuntime';
import {
  discardPreMigrateSnapshot,
  importLegacyDatabase,
  inspectDatabaseFile,
  readJournalEntries,
  restorePreMigrateSnapshot,
  snapshotBeforeMigrate,
  upToDateWith,
} from './legacyImport';
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

/**
 * 还没跑过的迁移条数。读不出来时按 0 处理：宁可少备份一次，也别拦住启动。
 *
 * 判据必须和 Drizzle 自己那套一模一样——它按 created_at 取水位，跑所有 when
 * 更大的迁移，而不是按条数补齐（drizzle-orm/sqlite-core/dialect.cjs 的 migrate）。
 * 这里原本拿 journal 条数减日志行数，两者只要对不上就永远算出「还有待跑的」，
 * 于是每次启动都白做一次全库 VACUUM，把真正那份升级前快照挤出保留窗口。
 */
function journalWhens(): number[] {
  return readJournalEntries(migrationsFolder()).map((entry) => entry.when);
}

function pendingMigrationCount(handle: Database.Database): number {
  const whens = journalWhens();
  if (whens.length === 0) return 0;

  const hasLog = handle
    .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'`)
    .get() as { n: number };
  if (hasLog.n === 0) return whens.length;

  const row = handle.prepare(`SELECT max(created_at) AS watermark FROM __drizzle_migrations`).get() as {
    watermark: number | null;
  };
  if (row.watermark === null) return whens.length;

  return whens.filter((when) => when > Number(row.watermark)).length;
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
  const folder = migrationsFolder();
  const whens = journalWhens();

  try {
    // 清掉上一次异常退出可能留下的临时快照。它只服务于单次迁移尝试，跨启动毫无意义。
    discardPreMigrateSnapshot(dbFile);

    // 先看这份文件到底是什么：0.6.x 旧库的迁移日志属于那一条线，直接原地重放会在
    // 已存在的表上撞车，且失败发生在迁移中途。识别出来就走整库导入（备份 → 新库 → 搬行）。
    const inspection = inspectDatabaseFile(dbFile, whens);
    if (inspection.kind === 'legacy-0.6.x') {
      raw = importLegacyDatabase({ dbFile, migrationsFolder: folder }).raw;
      db = drizzle(raw, { schema });
    } else {
      raw = new Database(dbFile);

      // WAL 让读写不互斥，长任务写入时 UI 查询不会被阻塞
      raw.pragma('journal_mode = WAL');
      // SQLite 默认不启用外键约束，schema 里的 onDelete 需要它才生效
      raw.pragma('foreign_keys = ON');

      db = drizzle(raw, { schema });
      backupBeforeMigrations(raw);

      // 「已经装了用户数据、又落后于当前 journal」的库才需要在迁移前留一份可回滚的临时快照：
      // 全新安装没有可丢的东西，已经最新的库迁移是空转，二者都不该多拷一份整库。
      const behind = inspection.kind === 'current' && !upToDateWith(inspection.appliedWhens, whens);
      if (!behind) {
        migrate(db, { migrationsFolder: folder });
      } else {
        snapshotBeforeMigrate(dbFile, raw);
        try {
          migrate(db, { migrationsFolder: folder });
          discardPreMigrateSnapshot(dbFile);
        } catch (migrateError) {
          // 迁移把库改坏了（半迁移的库会在这里撞上已存在的表）。先把连接关掉、把原库恢复成
          // 迁移尝试之前的字节，再走整库导入：备份 → 全新当前 schema → 按列形状搬行 → 写标记。
          // 导入若也失败，就抛 LegacyImportError，启动链照旧按「打开失败」处理并保留备份。
          const message = migrateError instanceof Error ? migrateError.message : String(migrateError);
          console.warn(`[startup] 数据库迁移没跑通，改用整库导入恢复：${message}`);
          try {
            raw?.close();
          } catch {
            // 连接可能已经不可用
          }
          raw = null;
          db = null;
          restorePreMigrateSnapshot(dbFile);
          raw = importLegacyDatabase({ dbFile, migrationsFolder: folder }).raw;
          db = drizzle(raw, { schema });
        }
      }
    }
  } catch (error) {
    // 打开/迁移/导入失败时不留半开的连接，也不缓存半初始化的 db：
    // 调用方（启动链）据此统一报错退出，而不是带着残状态继续跑到首次查询才炸。
    try {
      raw?.close();
    } catch {
      // 连接可能压根没打开，或已经关掉了
    }
    raw = null;
    db = null;
    throw error;
  }

  import('../jobTarget/backfill').then(({ backfillJobTargetsFromCampaigns }) => {
    backfillJobTargetsFromCampaigns();
  }).catch(() => {});

  // 迁移之后才装：触发器要写 sync_oplog / sync_meta，这两张表由迁移创建
  initSyncLayer(raw);

  const pluginBackfill = backfillPrePluginCampaignRuntime(raw);
  if (pluginBackfill.failures.length > 0) {
    console.warn('部分旧 Campaign 插件运行时回填失败，将在下次启动重试', pluginBackfill.failures);
  }

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
