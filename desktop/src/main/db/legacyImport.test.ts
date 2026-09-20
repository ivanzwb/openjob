/**
 * 0.6.x → 当前线 的整库升级闸门。
 *
 * 这里不满足于「函数返回了什么」，而是驱动应用真正的 DB 打开路径（getDb）：在临时目录里
 * 用 release/0.6.x 自己那 23 条迁移重建一个带真实用户数据的旧库，再让它升级，逐条验证
 * 数据有没有到、schema 有没有齐、标记有没有只写一次、备份有没有被动过，以及「已是最新」
 * 与「全新安装」两种库仍然走老路。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRE_PLUGIN_CAMPAIGN_SCOPE_KIND } from '@core/planner/contributions';
import { softwareEngineeringRolePack } from '@plugins/softwareEngineering';
import { backfillPrePluginCampaignRuntime } from './backfill/pluginRuntime';
import {
  LEGACY_BACKUP_SUFFIX,
  LEGACY_IMPORT_CHECKPOINT_KIND,
  LEGACY_IMPORT_MARKER_KEY,
  LegacyImportError,
  importLegacyDatabase,
  inspectDatabase,
} from './legacyImport';

const DESKTOP_DIR = join(__dirname, '..', '..', '..');
const MIGRATIONS_DIR = join(DESKTOP_DIR, 'src', 'main', 'db', 'migrations');
/** release/0.6.x 自己那 23 条迁移与 journal（见该目录；不依赖 git 历史） */
const LEGACY_06_DIR = join(__dirname, '__fixtures__', 'legacy06');
const DB_FILE = 'openjob.db';

interface LegacyMigration {
  tag: string;
  when: number;
  sql: string;
}

function legacy06Migrations(): LegacyMigration[] {
  const journalRaw = readFileSync(join(LEGACY_06_DIR, 'journal.json'), 'utf8');
  const entries = (JSON.parse(journalRaw) as { entries: { tag: string; when: number }[] }).entries;
  return entries.map((entry) => ({
    ...entry,
    sql: readFileSync(join(LEGACY_06_DIR, `${entry.tag}.sql`), 'utf8'),
  }));
}

const state = { userData: '' };

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? state.userData : join(state.userData, name)),
    getAppPath: () => DESKTOP_DIR,
    isPackaged: false,
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8'),
  },
}));

function journalWhens(): number[] {
  const raw = readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8');
  return (JSON.parse(raw) as { entries: { when: number }[] }).entries.map((entry) => entry.when);
}

function applySql(db: Database.Database, sql: string): void {
  for (const statement of sql.split('--> statement-breakpoint')) {
    if (statement.trim()) db.exec(statement);
  }
}

/** 用 0.6.x 自己的迁移建旧库，并补上那一线由 Drizzle 写下的迁移日志与真实用户数据。 */
function buildLegacyDb(path: string): void {
  const db = new Database(path);
  db.pragma('foreign_keys = OFF');
  const migrations = legacy06Migrations();
  for (const migration of migrations) applySql(db, migration.sql);

  db.exec(
    `CREATE TABLE __drizzle_migrations (
       id SERIAL PRIMARY KEY,
       hash text NOT NULL,
       created_at numeric
     )`,
  );
  const log = db.prepare(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)`);
  for (const migration of migrations) {
    log.run(createHash('sha256').update(migration.sql).digest('hex'), migration.when);
  }

  const t = 1_700_000_000_000;
  db.prepare(
    `INSERT INTO resume (id, label, raw_text, parsed, created_at, updated_at, preview_style, photo)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run('legacy-resume', '母版简历', '十年后端经验', JSON.stringify({ summary: '后端' }), t, t);
  db.prepare(
    `INSERT INTO job_target (id, company, role_title, jd_raw, jd_parsed, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
  ).run('legacy-target', '示例科技', '后端工程师', '熟悉 MySQL', t, t);
  db.prepare(
    `INSERT INTO campaign (
       id, company, role_title, jd_raw, jd_parsed, resume_id, interview_date,
       daily_minutes, status, created_at, updated_at, job_target_id
     ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'planning', ?, ?, ?)`,
  ).run(
    'legacy-campaign',
    '示例科技',
    '后端工程师',
    '熟悉 MySQL',
    'legacy-resume',
    '2026-03-09',
    180,
    t,
    t,
    'legacy-target',
  );
  db.prepare(
    `INSERT INTO knowledge_node (id, campaign_id, parent_id, name, kind, coverage_type, created_at)
     VALUES (?, ?, NULL, ?, 'domain', 'deepDive', ?)`,
  ).run('legacy-node', 'legacy-campaign', '后端基础', t);
  db.prepare(
    `INSERT INTO plan_day (id, campaign_id, date, planned_minutes, status)
     VALUES (?, ?, ?, ?, 'pending')`,
  ).run('legacy-day', 'legacy-campaign', '2026-03-02', 150);
  db.prepare(
    `INSERT INTO task (id, plan_day_id, node_id, repo_id, kind, est_minutes, status, order_idx)
     VALUES (?, ?, ?, NULL, 'learn', 30, 'done', 0)`,
  ).run('legacy-task', 'legacy-day', 'legacy-node');
  db.prepare(`INSERT INTO repo (id, url, local_path, status) VALUES (?, ?, ?, 'ready')`).run(
    'legacy-repo',
    'https://example.com/x.git',
    '/tmp/legacy/x',
  );
  // 已排好的 readCode：材料标识靠 0029 的 RENAME 变成 material_id，取值要原样保留
  db.prepare(
    `INSERT INTO task (id, plan_day_id, node_id, repo_id, kind, est_minutes, status, order_idx)
     VALUES (?, ?, NULL, ?, 'readCode', 25, 'pending', 5)`,
  ).run('legacy-task-readcode', 'legacy-day', 'legacy-repo');
  db.prepare(
    `INSERT INTO speech_snippet (id, source_type, source_id, tier, content_md, created_at)
     VALUES (?, 'node', ?, 'brief', ?, ?)`,
  ).run('legacy-speech', 'legacy-node', '先说结论再展开', t);

  db.close();
}

/** 用当前线的迁移把一份库建到最新形状（不是 0.6.x）。 */
function buildCurrentDb(path: string): void {
  const db = new Database(path);
  migrate(drizzle(db), { migrationsFolder: MIGRATIONS_DIR });
  db.close();
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

interface DbModule {
  getDb: () => unknown;
  getRawDb: () => Database.Database;
  closeDb: () => void;
}

let loaded: DbModule | null = null;

async function loadDbModule(): Promise<DbModule> {
  vi.resetModules();
  return (await import('./index')) as unknown as DbModule;
}

function openApp(): Promise<DbModule> {
  return loadDbModule().then((module) => {
    loaded = module;
    return module;
  });
}

function countOf(raw: Database.Database, sql: string, ...args: unknown[]): number {
  return (raw.prepare(sql).get(...args) as { n: number }).n;
}

describe('旧库识别', () => {
  it('空库判 fresh，0.6.x 形状判 legacy，当前线判 current', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openjob-detect-'));
    try {
      const fresh = new Database(join(dir, 'fresh.db'));
      expect(inspectDatabase(fresh, journalWhens()).kind).toBe('fresh');
      fresh.close();

      const legacyPath = join(dir, 'legacy.db');
      buildLegacyDb(legacyPath);
      const legacy = new Database(legacyPath);
      expect(inspectDatabase(legacy, journalWhens()).kind).toBe('legacy-0.6.x');
      legacy.close();

      const currentPath = join(dir, 'current.db');
      buildCurrentDb(currentPath);
      const current = new Database(currentPath);
      expect(inspectDatabase(current, journalWhens()).kind).toBe('current');
      current.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('0.6.x 旧库升级', () => {
  beforeEach(() => {
    state.userData = mkdtempSync(join(tmpdir(), 'openjob-upgrade-'));
    loaded = null;
  });

  afterEach(async () => {
    await flushAsync();
    loaded?.closeDb();
    loaded = null;
    vi.resetModules();
    // Windows 上文件句柄回收有延迟，重试几次再删，避免用例因清理 EPERM 误报
    rmSync(state.userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('整库导入：数据到位、新 schema 齐全、写标记、备份逐字节保留', async () => {
    const dbFile = join(state.userData, DB_FILE);
    buildLegacyDb(dbFile);
    const originalBytes = readFileSync(dbFile);

    const module = await openApp();
    module.getDb();
    await flushAsync();
    const raw = module.getRawDb();

    // 真实用户数据都还在
    expect(raw.prepare(`SELECT label FROM resume WHERE id = 'legacy-resume'`).get()).toEqual({
      label: '母版简历',
    });
    expect(raw.prepare(`SELECT name FROM knowledge_node WHERE id = 'legacy-node'`).get()).toEqual({
      name: '后端基础',
    });
    expect(raw.prepare(`SELECT kind, status FROM task WHERE id = 'legacy-task'`).get()).toEqual({
      kind: 'learn',
      status: 'done',
    });
    // 改名过的列：取值必须原样搬过来
    expect(
      raw.prepare(`SELECT material_id, kind FROM task WHERE id = 'legacy-task-readcode'`).get(),
    ).toEqual({ material_id: 'legacy-repo', kind: 'readCode' });
    expect(
      raw.prepare(`SELECT content_md FROM speech_snippet WHERE id = 'legacy-speech'`).get(),
    ).toEqual({ content_md: '先说结论再展开' });
    expect(raw.prepare(`SELECT company FROM campaign WHERE id = 'legacy-campaign'`).get()).toEqual({
      company: '示例科技',
    });

    // 新 schema 齐全：插件化之后的表都在
    for (const table of [
      'role_profile',
      'campaign_plugin_binding',
      'campaign_runtime_descriptor',
      'migration_checkpoint',
      'candidate_evidence',
      'practice_session',
      'story',
      'plugin_data',
    ]) {
      expect(
        countOf(raw, `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`, table),
      ).toBe(1);
    }
    // 迁移日志记到当前线最后一条（说明是「跑齐了再搬行」）
    const newest = Math.max(...journalWhens());
    expect(
      countOf(raw, `SELECT count(*) AS n FROM __drizzle_migrations WHERE created_at = ?`, newest),
    ).toBe(1);

    // 一次性标记
    const markerRow = raw
      .prepare(`SELECT value FROM sync_meta WHERE key = ?`)
      .get(LEGACY_IMPORT_MARKER_KEY) as { value: string };
    const marker = JSON.parse(markerRow.value) as { kind: string; backupFile: string };
    expect(marker.kind).toBe(LEGACY_IMPORT_CHECKPOINT_KIND);
    expect(marker.backupFile).toBe(`${dbFile}${LEGACY_BACKUP_SUFFIX}`);

    // 备份存在且和原始字节一模一样
    const backup = `${dbFile}${LEGACY_BACKUP_SUFFIX}`;
    expect(existsSync(backup)).toBe(true);
    expect(readFileSync(backup).equals(originalBytes)).toBe(true);
  });

  it('导入的旧战役带上 prePlugin 标记，既有的插件运行时回填仍能选中它', async () => {
    const dbFile = join(state.userData, DB_FILE);
    buildLegacyDb(dbFile);

    const module = await openApp();
    module.getDb();
    await flushAsync();
    const raw = module.getRawDb();

    // 0027 在空表上跑过，导入要补上这条「插件化之前就已存在」的凭据
    expect(
      countOf(
        raw,
        `SELECT count(*) AS n FROM migration_checkpoint WHERE campaign_id = 'legacy-campaign' AND kind = ?`,
        PRE_PLUGIN_CAMPAIGN_SCOPE_KIND,
      ),
    ).toBe(1);

    // 装上岗位包后的真实回填（plugins/bootstrap 走的就是这条）应当认领它
    const report = backfillPrePluginCampaignRuntime(raw, {
      pack: softwareEngineeringRolePack,
      now: () => 1_700_000_001_000,
    });
    expect(report).toEqual({ completed: 1, failures: [] });
    const campaign = raw
      .prepare(`SELECT role_profile_id FROM campaign WHERE id = 'legacy-campaign'`)
      .get() as { role_profile_id: string | null };
    expect(campaign.role_profile_id).not.toBeNull();
  });

  it('第二次打开是空转：不重复导入、不重复写标记、备份仍是原始字节', async () => {
    const dbFile = join(state.userData, DB_FILE);
    buildLegacyDb(dbFile);
    const originalBytes = readFileSync(dbFile);

    let module = await openApp();
    module.getDb();
    await flushAsync();
    const firstRaw = module.getRawDb();

    const countsAfterFirst = {
      campaign: countOf(firstRaw, `SELECT count(*) AS n FROM campaign`),
      task: countOf(firstRaw, `SELECT count(*) AS n FROM task`),
      marker: countOf(firstRaw, `SELECT count(*) AS n FROM sync_meta WHERE key = ?`, LEGACY_IMPORT_MARKER_KEY),
    };
    expect(countsAfterFirst.campaign).toBe(1);
    expect(countsAfterFirst.task).toBe(2);
    expect(countsAfterFirst.marker).toBe(1);
    module.closeDb();

    // 全新模块（清掉模块级 db 缓存），再走一次真正的打开路径
    module = await openApp();
    module.getDb();
    await flushAsync();
    const raw = module.getRawDb();

    expect(countOf(raw, `SELECT count(*) AS n FROM campaign`)).toBe(countsAfterFirst.campaign);
    expect(countOf(raw, `SELECT count(*) AS n FROM task`)).toBe(countsAfterFirst.task);
    expect(
      countOf(raw, `SELECT count(*) AS n FROM sync_meta WHERE key = ?`, LEGACY_IMPORT_MARKER_KEY),
    ).toBe(1);
    expect(readFileSync(`${dbFile}${LEGACY_BACKUP_SUFFIX}`).equals(originalBytes)).toBe(true);
  });

  it('已是当前线的库走正常路径：不建备份、不写导入标记', async () => {
    const dbFile = join(state.userData, DB_FILE);
    buildCurrentDb(dbFile);

    const module = await openApp();
    module.getDb();
    await flushAsync();
    const raw = module.getRawDb();

    expect(existsSync(`${dbFile}${LEGACY_BACKUP_SUFFIX}`)).toBe(false);
    expect(
      countOf(raw, `SELECT count(*) AS n FROM sync_meta WHERE key = ?`, LEGACY_IMPORT_MARKER_KEY),
    ).toBe(0);
    expect(countOf(raw, `SELECT count(*) AS n FROM __drizzle_migrations`)).toBe(journalWhens().length);
  });

  it('全新安装走正常路径：建齐 schema，不建备份、不写导入标记', async () => {
    const dbFile = join(state.userData, DB_FILE);
    expect(existsSync(dbFile)).toBe(false);

    const module = await openApp();
    module.getDb();
    await flushAsync();
    const raw = module.getRawDb();

    expect(
      countOf(raw, `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'role_profile'`),
    ).toBe(1);
    expect(existsSync(`${dbFile}${LEGACY_BACKUP_SUFFIX}`)).toBe(false);
    expect(
      countOf(raw, `SELECT count(*) AS n FROM sync_meta WHERE key = ?`, LEGACY_IMPORT_MARKER_KEY),
    ).toBe(0);
  });
});

describe('旧库导入失败', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openjob-import-fail-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('迁移跑不起来时抛带备份路径的错误，原库不动、备份已在、临时文件清干净', () => {
    const dbFile = join(dir, DB_FILE);
    buildLegacyDb(dbFile);
    const originalBytes = readFileSync(dbFile);

    // 指向一个不存在的迁移目录，逼导入在「建新库」这一步失败
    expect(() =>
      importLegacyDatabase({ dbFile, migrationsFolder: join(dir, 'no-such-migrations') }),
    ).toThrow(LegacyImportError);

    // 原始库字节未变，备份已生成，临时文件清掉
    expect(readFileSync(dbFile).equals(originalBytes)).toBe(true);
    expect(existsSync(`${dbFile}${LEGACY_BACKUP_SUFFIX}`)).toBe(true);
    expect(existsSync(`${dbFile}.legacy-import.tmp`)).toBe(false);
  });

  it('原库为空、没有可导入的东西时也不会把原文件搞坏', () => {
    const dbFile = join(dir, DB_FILE);
    const empty = new Database(dbFile);
    empty.close();
    const sizeBefore = statSync(dbFile).size;

    expect(() =>
      importLegacyDatabase({ dbFile, migrationsFolder: join(dir, 'no-such-migrations') }),
    ).toThrow(LegacyImportError);
    expect(statSync(dbFile).size).toBe(sizeBefore);
  });
});
