import type { SQLiteDatabase } from 'expo-sqlite';
import { MIGRATIONS } from './migrations/bundle';
import { columnExists, columnIsNotNull, hasTable } from './schemaEnsure';

/**
 * 迁移日志表:记录已应用的迁移序号,避免每次启动都重放建表 SQL。
 * 对迁移已部分应用的旧数据库,语句级容错自动跳过已存在对象。
 */
export const MIGRATION_LOG = '_migrations';

export function ensureMigrationLog(sqlite: SQLiteDatabase): void {
  sqlite.execSync(
    `CREATE TABLE IF NOT EXISTS ${MIGRATION_LOG} (idx INTEGER PRIMARY KEY, tag TEXT NOT NULL, applied_at INTEGER NOT NULL)`,
  );
}

function isAlreadyAppliedError(e: unknown): boolean {
  return /already exists|duplicate column name/i.test(String(e));
}

export function userTableCount(sqlite: SQLiteDatabase): number {
  return (
    sqlite.getFirstSync<{ n: number }>(
      `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )?.n ?? 0
  );
}

/**
 * 日志说这条跑过了，但库里那个东西压根不在。
 *
 * 早期版本的语句级容错会把建表 SQL 当成「已存在」跳过，日志却照记不误，于是
 * 日志和真实 schema 对不上。这几条只能靠自省判断，不能信日志。
 */
function needsReplay(sqlite: SQLiteDatabase, index: number): boolean {
  switch (index) {
    case 6:
      return !hasTable(sqlite, 'app_setting');
    case 7:
      return !hasTable(sqlite, 'repo_file');
    case 8:
      return !hasTable(sqlite, 'job_target');
    case 9:
      return !columnExists(sqlite, 'resume_variant', 'preview_style');
    case 10:
      return !columnExists(sqlite, 'resume', 'preview_style');
    case 11:
      // 建表 SQL 被容错跳过时,旧版还挂着 NOT NULL + CASCADE,重放这次重建
      return columnIsNotNull(sqlite, 'resume_variant', 'source_resume_id');
    default:
      return false;
  }
}

/**
 * 这次启动真正会执行的迁移序号。
 *
 * 备份闸门和迁移执行必须问同一个问题。这两边各算各的时出过一次事：日志条数
 * 齐了所以不备份，而上面那段自省又把序号 11 那条重建表的迁移放了进来——整份
 * 清单里唯一会删表的迁移，恰好在没有退路的情况下跑。
 */
export function pendingMigrationIndices(sqlite: SQLiteDatabase): number[] {
  ensureMigrationLog(sqlite);
  const applied = new Set(
    sqlite.getAllSync<{ idx: number }>(`SELECT idx FROM ${MIGRATION_LOG}`).map((r) => r.idx),
  );

  const pending: number[] = [];
  for (let index = 0; index < MIGRATIONS.length; index++) {
    if (!applied.has(index) || needsReplay(sqlite, index)) pending.push(index);
  }
  return pending;
}

export function runMigrations(sqlite: SQLiteDatabase): void {
  for (const index of pendingMigrationIndices(sqlite)) {
    // 一条迁移一个事务。序号 11 那条是「建新表-搬数据-删旧表-改名」四步，不包
    // 事务时在删表和改名之间断电，留下的是一个没有 resume_variant、数据全在
    // __new_resume_variant 里的库；重放时第一句建表被容错当成「已存在」跳过，
    // 第二句就撞上 no such table,从此每次启动都挂在同一行,应用再也打不开。
    // 回滚掉整条重来才是能自愈的形态——SQLite 的 DDL 本来就是事务性的。
    sqlite.withTransactionSync(() => {
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
        `INSERT INTO ${MIGRATION_LOG} (idx, tag, applied_at) VALUES (?, ?, ?)
         ON CONFLICT(idx) DO UPDATE SET applied_at = excluded.applied_at`,
        index,
        `migration_${index}`,
        Date.now(),
      );
    });
  }
}
