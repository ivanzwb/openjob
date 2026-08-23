/**
 * 迁移执行器的真库测试。
 *
 * 手机端的迁移是「容错重放」式的：语句报已存在就跳过。这套东西只有在整条迁移
 * 要么全做要么全不做时才成立——序号 11 那条是建新表、搬数据、删旧表、改名四步，
 * 一旦在删表和改名之间断掉，重放会先把建表当成已存在跳过，再撞上 no such table，
 * 而这个错不在容错白名单里，于是每次启动都挂在同一行，应用彻底打不开。
 *
 * 类型检查看不见拼出来的 SQL，也看不见断电。只能真建一个库，把中断打进去。
 */
import { DatabaseSync } from 'node:sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from './migrations/bundle';
import { pendingMigrationIndices, runMigrations } from './migrate';

/** 下一句 execSync 撞上它就抛错，用来模拟迁移跑到一半进程被杀 */
let crashOn: RegExp | null = null;

/**
 * 用 node:sqlite 顶替 expo-sqlite。
 *
 * expo-sqlite 是 RN 原生模块，在 vitest 的 node 进程里根本加载不了。要测的是
 * 这些 SQL 在真实 SQLite 上的行为，换个驱动不影响——补上 expo 那几个 *Sync
 * 方法就够了。
 */
function adapt(db: DatabaseSync): SQLiteDatabase {
  const shim = {
    execSync: (sql: string) => {
      if (crashOn?.test(sql)) throw new Error('模拟断电：进程在这一句上被杀');
      db.exec(sql);
    },
    runSync: (sql: string, ...args: unknown[]) => db.prepare(sql).run(...(args as never[])),
    getAllSync: (sql: string, ...args: unknown[]) => db.prepare(sql).all(...(args as never[])),
    getFirstSync: (sql: string, ...args: unknown[]) =>
      db.prepare(sql).get(...(args as never[])) ?? null,
    withTransactionSync: (task: () => void) => {
      db.exec('BEGIN');
      try {
        task();
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    closeSync: () => db.close(),
  };
  return shim as unknown as SQLiteDatabase;
}

let sqlite: SQLiteDatabase;

/** 只跑到序号 10 为止的旧库，模拟一个还没升级过的存量安装 */
function oldDbThroughMigration10(): void {
  sqlite.execSync(
    `CREATE TABLE IF NOT EXISTS _migrations (idx INTEGER PRIMARY KEY, tag TEXT NOT NULL, applied_at INTEGER NOT NULL)`,
  );
  for (let i = 0; i <= 10; i++) {
    for (const stmt of MIGRATIONS[i].split('--> statement-breakpoint')) {
      const trimmed = stmt.trim();
      if (trimmed) sqlite.execSync(trimmed);
    }
    sqlite.runSync(
      `INSERT INTO _migrations (idx, tag, applied_at) VALUES (?, ?, ?)`,
      i,
      `migration_${i}`,
      1,
    );
  }
}

/** 按真实 schema 拼 INSERT，省得跟着列名变化改测试 */
function insertRow(table: string, overrides: Record<string, string | number>): void {
  const cols = sqlite
    .getAllSync<{ name: string; type: string; notnull: number }>(`PRAGMA table_info(${table})`)
    .filter((c) => c.notnull === 1 || c.name in overrides);
  const values: (string | number)[] = cols.map((c) =>
    c.name in overrides ? overrides[c.name] : /INT|REAL|NUM/i.test(c.type) ? 1 : 'x',
  );
  sqlite.runSync(
    `INSERT INTO ${table} (${cols.map((c) => `\`${c.name}\``).join(',')})
     VALUES (${cols.map(() => '?').join(',')})`,
    ...values,
  );
}

function seedTailoredResume(): void {
  insertRow('resume', { id: 'r1' });
  insertRow('job_target', { id: 'j1', company: 'ACME' });
  insertRow('resume_variant', {
    id: 'v1',
    source_resume_id: 'r1',
    job_target_id: 'j1',
    label: '投 ACME 版',
    content_md: '# 花了两小时改出来的简历',
  });
}

function variantCount(): number {
  return sqlite.getFirstSync<{ n: number }>(`SELECT count(*) AS n FROM resume_variant`)?.n ?? 0;
}

function tableExists(name: string): boolean {
  return Boolean(
    sqlite.getFirstSync(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, name),
  );
}

beforeEach(() => {
  crashOn = null;
  sqlite = adapt(new DatabaseSync(':memory:'));
  sqlite.execSync('PRAGMA foreign_keys = ON');
});

describe('runMigrations', () => {
  it('空库能一路跑完，序号 11 的重建生效', () => {
    runMigrations(sqlite);

    const col = sqlite
      .getAllSync<{ name: string; notnull: number }>(`PRAGMA table_info(resume_variant)`)
      .find((c) => c.name === 'source_resume_id');
    expect(col?.notnull).toBe(0);
    expect(pendingMigrationIndices(sqlite)).toEqual([]);
  });

  it('跨版本升级把中间每一条都补上', () => {
    oldDbThroughMigration10();
    expect(pendingMigrationIndices(sqlite)).toEqual([11, 12, 13, 14, 15, 16, 17, 18]);

    runMigrations(sqlite);

    expect(pendingMigrationIndices(sqlite)).toEqual([]);
  });

  it('重建表的迁移断在删表和改名之间，下次启动能自愈且数据还在', () => {
    oldDbThroughMigration10();
    seedTailoredResume();
    expect(variantCount()).toBe(1);

    // 第一次启动：跑到 RENAME 时进程被杀
    crashOn = /ALTER TABLE .__new_resume_variant. RENAME/;
    expect(() => runMigrations(sqlite)).toThrow('模拟断电');

    // 事务整条回滚，库还是断电前那个样子——没有半张表，也没有孤儿表
    expect(tableExists('resume_variant')).toBe(true);
    expect(tableExists('__new_resume_variant')).toBe(false);
    expect(variantCount()).toBe(1);

    // 第二次启动：重放同一条，这次跑完
    crashOn = null;
    expect(() => runMigrations(sqlite)).not.toThrow();

    expect(variantCount()).toBe(1);
    expect(
      sqlite.getFirstSync<{ content_md: string }>(`SELECT content_md FROM resume_variant`)
        ?.content_md,
    ).toBe('# 花了两小时改出来的简历');
    expect(pendingMigrationIndices(sqlite)).toEqual([]);
  });
});

describe('pendingMigrationIndices', () => {
  /**
   * 备份闸门读的就是这个函数。以前它只看日志条数，而执行那边额外做 schema
   * 自省，于是「日志齐了所以不备份」和「自省说要重建所以照跑」同时成立，
   * 唯一会删表的迁移在没有快照的情况下执行。
   */
  it('日志记满但 schema 没跟上时，仍然报告有待跑的迁移', () => {
    runMigrations(sqlite);
    expect(pendingMigrationIndices(sqlite)).toEqual([]);

    // 把 resume_variant 退回重建之前的形态：source_resume_id 还是 NOT NULL
    sqlite.execSync(`DROP TABLE resume_variant`);
    sqlite.execSync(`
      CREATE TABLE resume_variant (
        id text PRIMARY KEY NOT NULL,
        source_resume_id text NOT NULL,
        job_target_id text NOT NULL,
        label text NOT NULL,
        content_md text NOT NULL,
        changelog_md text DEFAULT '' NOT NULL,
        preview_style text,
        is_user_edited integer DEFAULT false NOT NULL,
        created_at integer NOT NULL,
        updated_at integer NOT NULL
      )`);

    expect(pendingMigrationIndices(sqlite)).toContain(11);
  });
});
