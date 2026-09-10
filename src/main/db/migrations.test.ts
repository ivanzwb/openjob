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
import { LEGACY_CAMPAIGN_SCOPE_KIND } from '@shared/planner/contributions';

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

const MOBILE_MIGRATIONS_DIR = join(process.cwd(), 'mobile', 'src', 'db', 'migrations');

function mobileJournal(): JournalEntry[] {
  const raw = readFileSync(join(MOBILE_MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8');
  return (JSON.parse(raw) as { entries: JournalEntry[] }).entries;
}

function mobileSqlFiles(): string[] {
  return readdirSync(MOBILE_MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

/**
 * 手机端迁移清单。
 *
 * 桌面那份清单上面已经逐条验过了，手机那份长期没人验——而它有两个各自独立、
 * 各自静默的事实源：运行时真正执行的是 `bundle.ts`（由 .sql 文件生成），
 * drizzle-kit 生成新迁移时看的却是 `meta/_journal.json`。两边只要有一边漏了
 * 一条，都不会有任何报错。
 */
describe('手机端迁移清单', () => {
  it('每条 journal 记录都有对应的 .sql，反过来也一样', () => {
    // 0020_campaign_resume_backfill 就这么缺过：文件在、bundle 里也在、
    // 于是运行时一切正常，但 journal 只有 24 条，drizzle-kit 生成下一条时
    // 会按第 24 条来命名，正好撞上已经存在的 0024_story
    const tags = mobileJournal().map((entry) => entry.tag);
    expect([...tags].sort()).toEqual(mobileSqlFiles().map((file) => file.replace(/\.sql$/, '')));
  });

  it('when 严格递增，否则新迁移会在已升级的手机库上被永久跳过', () => {
    const entries = mobileJournal();
    expect(
      entries
        .filter((entry, index) => index > 0 && entry.when <= entries[index - 1].when)
        .map((entry) => `${entry.tag} (when=${entry.when})`),
    ).toEqual([]);
  });

  it('idx 连续，没有空号', () => {
    expect(mobileJournal().map((entry) => entry.idx)).toEqual(
      mobileJournal().map((_, index) => index),
    );
  });

  it('bundle.ts 与 .sql 文件逐字对应，不会漏跑没重新打包的迁移', () => {
    // runMigrations 按 MIGRATIONS 的下标记录进度，所以少打包一条不是「晚一点跑」，
    // 而是那条永远不跑，且后面每一条的下标都错位
    const bundle = readFileSync(join(MOBILE_MIGRATIONS_DIR, 'bundle.ts'), 'utf8');
    const missing = mobileSqlFiles().filter(
      (file) =>
        !bundle.includes(JSON.stringify(readFileSync(join(MOBILE_MIGRATIONS_DIR, file), 'utf8'))),
    );

    expect(missing, '有迁移没重新打包：跑一次 npm run db:bundle').toEqual([]);
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

describe('legacy campaign scope migration', () => {
  const MOBILE_LEGACY_SCOPE = join(
    process.cwd(),
    'mobile',
    'src',
    'db',
    'migrations',
    '0025_legacy_campaign_scope.sql',
  );

  it('两端与共享常量用同一个 kind 字面量', () => {
    // 常量改了、SQL 没改的话，回填会一条也选不中，而且不会报错——只会静默不干活
    for (const [name, sql] of [
      ['desktop', sqlOf('0027_legacy_campaign_scope')],
      ['mobile', readFileSync(MOBILE_LEGACY_SCOPE, 'utf8')],
    ] as const) {
      expect(sql, name).toContain(`'${LEGACY_CAMPAIGN_SCOPE_KIND}'`);
    }
  });

  it('只标记迁移那一刻还没有岗位意图的 Campaign', () => {
    const db = new DatabaseSync(':memory:');
    const entries = journal();
    const cutoff = entries.findIndex((entry) => entry.tag === '0027_legacy_campaign_scope');
    expect(cutoff).toBeGreaterThan(0);
    entries.slice(0, cutoff).forEach((entry) => applySql(db, sqlOf(entry.tag)));

    const insertCampaign = `INSERT INTO campaign (
         id, company, role_title, jd_raw, status, created_at, updated_at
       ) VALUES (?, 'ACME', 'Engineer', 'JD', 'planning', 1, 1)`;
    db.prepare(insertCampaign).run('legacy');
    db.prepare(insertCampaign).run('profiled');
    db.prepare(
      `INSERT INTO role_profile (
         id, role_family, role_pack_id, level, industry_pack_id, location,
         interview_language, confidence, user_confirmed
       ) VALUES ('rp', 'product', 'product-manager', NULL, NULL, NULL, 'zh', 1, 1)`,
    ).run();
    db.prepare(`UPDATE campaign SET role_profile_id = 'rp' WHERE id = 'profiled'`).run();

    applySql(db, sqlOf('0027_legacy_campaign_scope'));

    expect(
      db
        .prepare(
          `SELECT campaign_id FROM migration_checkpoint WHERE kind = ? ORDER BY campaign_id`,
        )
        .all(LEGACY_CAMPAIGN_SCOPE_KIND),
    ).toEqual([{ campaign_id: 'legacy' }]);
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

describe('story migration', () => {
  it('桌面与手机使用同一份 T13 DDL', () => {
    const desktop = sqlOf('0026_story').replace(/\r\n/g, '\n');
    const mobile = readFileSync(
      join(process.cwd(), 'mobile', 'src', 'db', 'migrations', '0024_story.sql'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    expect(mobile).toBe(desktop);
  });

  /**
   * 「删 Story 不删 Evidence」这条验收，最终守在这里：story_evidence.evidence_id
   * 一旦被加成外键，删 Story 就有了一条可能级联到候选人事实的通路，而服务层的
   * 那句 DELETE 看起来仍然完全正常。
   */
  it('story_evidence 只对 story 有外键，指向 candidate_evidence 的那条边不存在', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    journal().forEach((entry) => applySql(db, sqlOf(entry.tag)));

    const parents = (
      db.prepare(`PRAGMA foreign_key_list('story_evidence')`).all() as Array<{ table: string }>
    ).map((fk) => fk.table);

    expect(parents).toEqual(['story']);
    db.close();
  });

  it('每个 Story 每档口述只能有一条：唯一索引在位', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    journal().forEach((entry) => applySql(db, sqlOf(entry.tag)));

    const indexes = db
      .prepare(`PRAGMA index_list(story_delivery)`)
      .all() as Array<{ name: string; unique: number }>;
    const duration = indexes.find((index) => index.name === 'uq_story_delivery_duration');

    expect(duration?.unique).toBe(1);
    expect(
      (db.prepare(`PRAGMA index_info(uq_story_delivery_duration)`).all() as Array<{
        name: string;
      }>).map((column) => column.name),
    ).toEqual(['story_id', 'duration_seconds']);
    db.close();
  });
});
