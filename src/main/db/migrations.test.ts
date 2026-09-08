/**
 * 迁移清单本身的体检。
 *
 * Drizzle 不按序号补齐迁移：它取日志里 created_at 的最大值当水位，只跑 when
 * 更大的那些（drizzle-orm/sqlite-core/dialect.cjs 的 migrate）。所以 journal 里
 * 一条 when 比前面小的迁移，会在所有「已经升过头」的库上被永久跳过——不报错，
 * 不重试，那张表就是永远建不出来。0013_prompt_run 真的这么丢过一次。
 *
 * 这类事故在类型检查和跑迁移里都看不出来（全新安装一切正常，日志空的时候
 * Drizzle 会把所有迁移都跑一遍），只能对着 journal 直接验。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = join(__dirname, 'migrations');

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

function journal(): JournalEntry[] {
  const raw = readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8');
  return (JSON.parse(raw) as { entries: JournalEntry[] }).entries;
}

function sqlOf(tag: string): string {
  return readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), 'utf8');
}

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function applySql(db: DatabaseSync, sql: string): void {
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const trimmed = stmt.trim();
    if (trimmed) db.exec(trimmed);
  }
}

/** 复刻 Drizzle 的挑选规则：水位取已应用记录里最大的 created_at，跑 when 更大的 */
function selectPending(entries: JournalEntry[], appliedWhens: number[]): JournalEntry[] {
  if (appliedWhens.length === 0) return entries;
  const watermark = Math.max(...appliedWhens);
  return entries.filter((e) => e.when > watermark);
}

describe('迁移 journal', () => {
  it('when 严格递增，否则新迁移会在已升级的库上被永久跳过', () => {
    const entries = journal();
    const outOfOrder = entries
      .filter((e, i) => i > 0 && e.when <= entries[i - 1].when)
      .map((e) => `${e.tag} (when=${e.when})`);

    expect(outOfOrder).toEqual([]);
  });

  it('每条 journal 记录都有对应的 .sql，反过来也一样', () => {
    const tags = journal().map((e) => e.tag);
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.replace(/\.sql$/, ''))
      .sort();

    expect([...tags].sort()).toEqual(files);
  });

  it('从任何一个历史版本升上来，都不会有迁移被落下', () => {
    const entries = journal();

    // 逐个模拟「旧库停在第 k 条」：剩下的每一条都必须被选中
    for (let k = 0; k < entries.length; k++) {
      const applied = entries.slice(0, k + 1).map((e) => e.when);
      const pending = selectPending(entries, applied).map((e) => e.tag);
      const expected = entries.slice(k + 1).map((e) => e.tag);

      expect(pending, `旧库停在 ${entries[k].tag} 时`).toEqual(expected);
    }
  });
});

describe('迁移 SQL 切分', () => {
  /**
   * Drizzle 把文件按 `--> statement-breakpoint` 切开后原样逐条 run，既不 trim
   * 也不跳过空串（migrator.js 里那个 map 就是 `return it`）。所以文件开头或结尾
   * 多一个分隔符，就会多出一条空语句，getDb() 直接抛「Failed to run the query ''」，
   * 应用连启动都启动不了——0022 就是这么把 CI 的启动冒烟弄挂的。
   *
   * 上面的 applySql 会把空语句过滤掉，正因如此它永远验不出这件事，这里必须照着
   * Drizzle 的方式原样切。
   */
  it('没有迁移会切出空语句或纯注释语句', () => {
    const offenders = journal()
      .map((e) => e.tag)
      .filter((tag) =>
        sqlOf(tag)
          .split('--> statement-breakpoint')
          .some((stmt) => stripSqlComments(stmt).trim() === ''),
      );

    expect(offenders).toEqual([]);
  });
});

describe('prompt_run 补建', () => {
  /**
   * 已经发出去的那批桌面端，__drizzle_migrations 里有 0013 之外的所有记录，
   * 而水位早已越过 0013 原来那个偏小的 when。0019 存在的唯一理由就是把这批库
   * 捞回来，所以这条用例盯的是「这个状态下 0019 会被选中」。
   */
  it('缺了 prompt_run 的存量库会跑到 0019', () => {
    const entries = journal();
    // 装了 0019 之前那一版（水位停在 0018）、且当时漏掉了 0013 的库。
    // 这里按「停在哪一条」正着描述，不是把不该有的挨个排除——后者每加一条新迁移
    // 就得记着来补一笔，漏补时水位会被新迁移顶过头，用例反而不再检查任何东西。
    const stoppedAt = entries.findIndex((e) => e.tag === '0018_sync_row_version');
    const applied = entries
      .slice(0, stoppedAt + 1)
      .filter((e) => e.tag !== '0013_prompt_run')
      .map((e) => e.when);

    const pending = selectPending(entries, applied).map((e) => e.tag);

    // 0013 的 when 已经落在水位下面，永远轮不到它了，补建只能靠 0019
    expect(pending[0]).toBe('0019_prompt_run_repair');
    expect(pending).toEqual(entries.slice(stoppedAt + 1).map((e) => e.tag));
  });

  it('0019 在已经有 prompt_run 的库上重跑不会炸', () => {
    const db = new DatabaseSync(':memory:');
    applySql(db, sqlOf('0013_prompt_run'));

    expect(() => applySql(db, sqlOf('0019_prompt_run_repair'))).not.toThrow();

    const row = db
      .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'prompt_run'`)
      .get() as { n: number };
    expect(row.n).toBe(1);
    db.close();
  });

  it('0013 自己重跑也不会炸——曾经停在 0013 的库会被新 when 拉着再跑一次', () => {
    const db = new DatabaseSync(':memory:');
    applySql(db, sqlOf('0013_prompt_run'));

    expect(() => applySql(db, sqlOf('0013_prompt_run'))).not.toThrow();
    db.close();
  });
});

describe('plugin runtime persistence migration', () => {
  it('桌面与手机使用同一份 T03 DDL', () => {
    const desktop = sqlOf('0023_plugin_runtime_persistence').replace(/\r\n/g, '\n');
    const mobile = readFileSync(
      join(process.cwd(), 'mobile', 'src', 'db', 'migrations', '0021_plugin_runtime_persistence.sql'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    expect(mobile).toBe(desktop);
  });

  it('空库迁移后新表和 Campaign 外键齐全', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    journal().forEach((entry) => applySql(db, sqlOf(entry.tag)));

    for (const table of [
      'role_profile',
      'campaign_plugin_binding',
      'campaign_runtime_descriptor',
      'migration_checkpoint',
    ]) {
      expect(
        db
          .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`)
          .get(table),
      ).toEqual({ n: 1 });
    }
    const roleProfileColumn = db
      .prepare(`PRAGMA table_info(campaign)`)
      .all()
      .find((column) => (column as { name: string }).name === 'role_profile_id');
    expect(roleProfileColumn).toBeDefined();
    db.close();
  });
});

describe('candidate evidence migration', () => {
  it('桌面与手机使用同一份 T10 DDL', () => {
    const desktop = sqlOf('0024_candidate_evidence').replace(/\r\n/g, '\n');
    const mobile = readFileSync(
      join(process.cwd(), 'mobile', 'src', 'db', 'migrations', '0022_candidate_evidence.sql'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    expect(mobile).toBe(desktop);
  });

  /**
   * 唯一索引是「重复抽取不会把已确认项打回待确认」的落库前提：同一段原文的同一
   * 类事实只能有一行，否则用户确认过的那条会被下一次抽取插出来的新行盖掉。
   */
  it('空库迁移后 candidate_evidence 的来源区间唯一索引在位', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    journal().forEach((entry) => applySql(db, sqlOf(entry.tag)));

    const indexes = db
      .prepare(`PRAGMA index_list(candidate_evidence)`)
      .all() as Array<{ name: string; unique: number }>;
    const span = indexes.find((index) => index.name === 'uq_candidate_evidence_span');

    expect(span?.unique).toBe(1);
    expect(
      (db.prepare(`PRAGMA index_info(uq_candidate_evidence_span)`).all() as Array<{
        name: string;
      }>).map((column) => column.name),
    ).toEqual([
      'campaign_id',
      'kind',
      'source_kind',
      'source_document_id',
      'source_start',
      'source_end',
    ]);
    db.close();
  });
});
