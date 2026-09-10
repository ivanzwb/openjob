/**
 * 用真实迁移文件搭起内存库的测试脚手架。
 *
 * `through` 是为兼容性回归准备的：要证明旧库不需要重建，就得先真的停在插件化
 * 之前那个 schema 上，再把后面的迁移补上去，而不是一次性建好完整 schema 再假装
 * 它很旧。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Database } from 'better-sqlite3';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

/** better-sqlite3 的最小接口垫片：迁移与回填只用到这几个方法。 */
export function adaptSqlite(db: DatabaseSync): Database {
  return {
    prepare: (sql: string) => {
      const statement = db.prepare(sql);
      return {
        all: (...args: unknown[]) => statement.all(...(args as never[])),
        get: (...args: unknown[]) => statement.get(...(args as never[])),
        run: (...args: unknown[]) => statement.run(...(args as never[])),
      };
    },
    exec: (sql: string) => db.exec(sql),
    transaction:
      (task: (...args: never[]) => unknown) =>
      (...args: never[]) => {
        db.exec('BEGIN');
        try {
          const result = task(...args);
          db.exec('COMMIT');
          return result;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
    close: () => db.close(),
  } as unknown as Database;
}

export function migrationTags(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => file.replace(/\.sql$/, ''));
}

export interface ApplyMigrationsOptions {
  /** 只应用到这条迁移（含）为止；省略则全部应用。 */
  through?: string;
  /** 跳过这条迁移之前的全部迁移（含），用于补齐后半段。 */
  after?: string;
}

export function applyMigrations(raw: Database, options: ApplyMigrationsOptions = {}): string[] {
  const tags = migrationTags();
  const start = options.after ? tags.indexOf(options.after) + 1 : 0;
  const end = options.through ? tags.indexOf(options.through) + 1 : tags.length;
  if (start < 0 || end <= 0) throw new Error('迁移边界不存在');

  const applied = tags.slice(start, end);
  applied.forEach((tag) => {
    const sql = readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), 'utf8');
    sql.split('--> statement-breakpoint').forEach((statement) => {
      if (statement.trim()) raw.exec(statement);
    });
  });
  return applied;
}

export function newLegacyDb(options: ApplyMigrationsOptions = {}): Database {
  const raw = adaptSqlite(new DatabaseSync(':memory:'));
  raw.exec('PRAGMA foreign_keys = ON');
  applyMigrations(raw, options);
  return raw;
}

export function userTables(raw: Database): string[] {
  return (
    raw
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

export function tableColumns(raw: Database, table: string): string[] {
  return (
    raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((row) => row.name);
}

export type TableShapes = Record<string, string[]>;
export type TableContents = Record<string, unknown[]>;

export function captureShapes(raw: Database): TableShapes {
  return Object.fromEntries(userTables(raw).map((table) => [table, tableColumns(raw, table)]));
}

/**
 * 按给定的表和列快照内容。
 *
 * 只读传入的列，所以后续迁移新增的列不会进比较——新增列本身不算「旧数据被改
 * 动」，真正要盯的是旧列的值有没有被悄悄重写。
 */
export function captureContents(raw: Database, shapes: TableShapes): TableContents {
  return Object.fromEntries(
    Object.entries(shapes).map(([table, columns]) => {
      const projection = columns.map((column) => `"${column}"`).join(', ');
      return [table, raw.prepare(`SELECT ${projection} FROM "${table}" ORDER BY rowid`).all()];
    }),
  );
}
