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
  PRE_MIGRATE_SNAPSHOT_SUFFIX,
  importLegacyDatabase,
  inspectDatabase,
  preMigrateSnapshotPath,
  restorePreMigrateSnapshot,
  snapshotBeforeMigrate,
  upToDateWith,
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

/**
 * 往已经建好的旧库里补一台「已配对」的手机，以及本机的同步身份。
 *
 * 0.6.x 的配对落在两处：`sync_peer` 一行（对端 deviceId + 配对时交换的共享密钥）
 * 与本机自己的身份 `sync_meta.deviceId`（对端用它来认这台桌面端）。两者缺一，
 * 升级后这台手机就再认不出桌面端（或反过来），配对等于丢了。
 */
function addPairedDevice(
  dbFile: string,
  peer: { deviceId: string; sharedKey: string; displayName: string },
  identity: { deviceId: string; displayName: string },
): void {
  const db = new Database(dbFile);
  const t = 1_700_000_000_000;
  db.prepare(
    `INSERT INTO sync_peer
       (device_id, display_name, platform, shared_key, last_address, last_local_seq, last_remote_seq, last_sync_at, paired_at)
     VALUES (?, ?, 'android', ?, '192.168.1.23', 0, 0, NULL, ?)`,
  ).run(peer.deviceId, peer.displayName, peer.sharedKey, t);
  const meta = db.prepare(`INSERT INTO sync_meta (key, value) VALUES (?, ?)`);
  meta.run('deviceId', identity.deviceId);
  meta.run('displayName', identity.displayName);
  db.close();
}

/**
 * 往已经建好的旧库里再补几张「当前线 schema 从没见过」的表，模拟库在旧线上漂移过形状。
 *
 * 现实里这种表来自用户手动建过的辅助表、第三方脚本、或更早的私有分支——`app_config`
 * 就是报告里那张：当前线（以及 release/0.6.x）里都没有它，可它实实在在躺在用户的库里。
 */
function addDriftedTables(dbFile: string, statements: string[]): void {
  const db = new Database(dbFile);
  db.pragma('foreign_keys = OFF');
  for (const statement of statements) db.exec(statement);
  db.close();
}

/** 用当前线的迁移把一份库建到最新形状（不是 0.6.x）。 */
function buildCurrentDb(path: string): void {
  const db = new Database(path);
  migrate(drizzle(db), { migrationsFolder: MIGRATIONS_DIR });
  db.close();
}

interface JournalEntryRow {
  tag: string;
  when: number;
}

function currentJournal(): JournalEntryRow[] {
  const raw = readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8');
  return (JSON.parse(raw) as { entries: JournalEntryRow[] }).entries;
}

/** 往当前 schema 里播一小组真实用户数据：整库导入后必须原样找回。 */
function seedCurrentUserData(db: Database.Database): void {
  const t = 1_700_000_000_000;
  db.prepare(
    `INSERT INTO resume (id, label, raw_text, parsed, created_at, updated_at)
     VALUES ('half-resume', '半迁移简历', '十年后端经验', ?, ?, ?)`,
  ).run(JSON.stringify({ summary: '后端' }), t, t);
  db.prepare(
    `INSERT INTO campaign (id, company, role_title, jd_raw, resume_id, status, created_at, updated_at)
     VALUES ('half-campaign', '半迁移科技', '后端工程师', '熟悉 MySQL', 'half-resume', 'planning', ?, ?)`,
  ).run(t, t);
  db.prepare(
    `INSERT INTO knowledge_node (id, campaign_id, name, kind, coverage_type, created_at)
     VALUES ('half-node', 'half-campaign', '后端基础', 'domain', 'deepDive', ?)`,
  ).run(t);
}

/**
 * 建一个「表跑到最新、迁移账却没记全」的半迁移库，模拟早先一次失败的迁移：
 * 表建出来了，对应的记录却没写进 __drizzle_migrations。（先把当前迁移跑齐、播好数据，
 * 再删掉 keepThrough 之后的迁移记录。）
 */
function buildHalfMigratedDb(path: string, keepThroughTag: string): void {
  const db = new Database(path);
  db.pragma('foreign_keys = OFF');
  migrate(drizzle(db), { migrationsFolder: MIGRATIONS_DIR });
  seedCurrentUserData(db);

  const entries = currentJournal();
  const cutoff = entries.findIndex((entry) => entry.tag === keepThroughTag);
  if (cutoff < 0) throw new Error(`journal 里没有 ${keepThroughTag}`);
  const dropped = entries.slice(cutoff + 1).map((entry) => entry.when);
  db.prepare(
    `DELETE FROM __drizzle_migrations WHERE created_at IN (${dropped.map(() => '?').join(', ')})`,
  ).run(...dropped);
  db.close();
}

/** 复刻 getDb 打开库时对主文件做的归一（WAL + checkpoint），拿到「迁移尝试前」的字节。 */
function normalizedBytes(dbFile: string): Buffer {
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  return readFileSync(dbFile);
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

  /**
   * 纯 0.6.x 的 when 恰好与当前线前 23 条重合、同样落在子集里。它之所以还得判 legacy，
   * 靠的是「一张插件化之后的表都没有」；只要承认「有插件表 = 是当前线」就会把它错判。
   */
  it('纯 0.6.x 的迁移日志是当前 journal 的子集，但因为没有插件表仍判 legacy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openjob-detect-'));
    try {
      const legacyPath = join(dir, 'legacy.db');
      buildLegacyDb(legacyPath);
      const legacy = new Database(legacyPath);
      const whens = journalWhens();
      const applied = (
        legacy.prepare(`SELECT created_at FROM __drizzle_migrations`).all() as {
          created_at: number;
        }[]
      ).map((row) => Number(row.created_at));
      // 前提：它的 when 确实全是当前 journal 的取值（子集），不是异线
      expect(applied.every((when) => whens.includes(when))).toBe(true);
      expect(inspectDatabase(legacy, whens).kind).toBe('legacy-0.6.x');
      legacy.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('有插件表但迁移日志不是子集（异线）→ legacy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openjob-detect-'));
    try {
      const path = join(dir, 'foreign.db');
      buildCurrentDb(path);
      const db = new Database(path);
      // 把其中一条记录改成一个当前 journal 里根本没有的 when：日志对不上了
      db.prepare(`UPDATE __drizzle_migrations SET created_at = 1 WHERE created_at = ?`).run(
        Math.max(...journalWhens()),
      );
      expect(inspectDatabase(db, journalWhens()).kind).toBe('legacy-0.6.x');
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('我们的线、只是落后几条（有插件表 + 日志是子集）→ current', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openjob-detect-'));
    try {
      const path = join(dir, 'behind.db');
      buildHalfMigratedDb(path, '0026_story');
      const db = new Database(path);
      const whens = journalWhens();
      expect(inspectDatabase(db, whens).kind).toBe('current');
      // 但它确实还没到最新（没记上最新那条），所以 getDb 会补上兜底快照
      expect(upToDateWith(inspectDatabase(db, whens).appliedWhens, whens)).toBe(false);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('半迁移库（表跑到最新、迁移账没记全）', () => {
  beforeEach(() => {
    state.userData = mkdtempSync(join(tmpdir(), 'openjob-halfmigrated-'));
    loaded = null;
  });

  afterEach(async () => {
    await flushAsync();
    loaded?.closeDb();
    loaded = null;
    vi.resetModules();
    rmSync(state.userData, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 });
  });

  /**
   * 复现报告里的场景：文件里有 role_profile，但 __drizzle_migrations 没记上那条。
   * 正常迁移会在已存在的表上撞车；兜底把它恢复成迁移前的字节，再走整库导入救回来。
   */
  it('迁移撞车后回退到整库导入：数据 intact、schema 齐、写标记、无残留快照', async () => {
    const dbFile = join(state.userData, DB_FILE);
    buildHalfMigratedDb(dbFile, '0026_story');
    // getDb 会在迁移前把主文件归一（WAL + checkpoint）再拷快照，复刻它才拿得到同一份字节
    const preAttemptBytes = normalizedBytes(dbFile);

    const module = await openApp();
    module.getDb();
    await flushAsync();
    const raw = module.getRawDb();

    // 用户数据原样找回
    expect(raw.prepare(`SELECT label FROM resume WHERE id = 'half-resume'`).get()).toEqual({
      label: '半迁移简历',
    });
    expect(raw.prepare(`SELECT company FROM campaign WHERE id = 'half-campaign'`).get()).toEqual({
      company: '半迁移科技',
    });
    expect(raw.prepare(`SELECT name FROM knowledge_node WHERE id = 'half-node'`).get()).toEqual({
      name: '后端基础',
    });

    // 迁移日志记到当前线最后一条、schema 齐全、一次性标记写入
    const newest = Math.max(...journalWhens());
    expect(
      countOf(raw, `SELECT count(*) AS n FROM __drizzle_migrations WHERE created_at = ?`, newest),
    ).toBe(1);
    for (const table of ['role_profile', 'plugin_data', 'practice_session', 'story']) {
      expect(
        countOf(raw, `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`, table),
      ).toBe(1);
    }
    expect(
      countOf(raw, `SELECT count(*) AS n FROM sync_meta WHERE key = ?`, LEGACY_IMPORT_MARKER_KEY),
    ).toBe(1);

    // 兜底用的临时快照必须清干净；永久备份保留，且是「迁移尝试之前」的那份字节
    expect(existsSync(preMigrateSnapshotPath(dbFile))).toBe(false);
    expect(existsSync(`${dbFile}${PRE_MIGRATE_SNAPSHOT_SUFFIX}-wal`)).toBe(false);
    expect(existsSync(`${dbFile}${PRE_MIGRATE_SNAPSHOT_SUFFIX}-shm`)).toBe(false);
    expect(existsSync(`${dbFile}${LEGACY_BACKUP_SUFFIX}`)).toBe(true);
    expect(readFileSync(`${dbFile}${LEGACY_BACKUP_SUFFIX}`).equals(preAttemptBytes)).toBe(true);
  });

  /**
   * 报告里的那一份：有 role_profile，但记录只到 0022——正常迁移重放的第一条就是
   * `CREATE TABLE role_profile`，正好在已存在的表上撞车。兜底恢复后走整库导入。
   */
  it('记录只到 0022、却已经有 role_profile：迁移在第一条 CREATE TABLE 上撞车后回退导入', async () => {
    const dbFile = join(state.userData, DB_FILE);
    buildHalfMigratedDb(dbFile, '0022_campaign_resume_backfill');

    const module = await openApp();
    module.getDb();
    await flushAsync();
    const raw = module.getRawDb();

    // 数据还在，schema 齐全，迁移日志补齐到最新
    expect(raw.prepare(`SELECT label FROM resume WHERE id = 'half-resume'`).get()).toEqual({
      label: '半迁移简历',
    });
    const newest = Math.max(...journalWhens());
    expect(
      countOf(raw, `SELECT count(*) AS n FROM __drizzle_migrations WHERE created_at = ?`, newest),
    ).toBe(1);
    expect(
      countOf(raw, `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'role_profile'`),
    ).toBe(1);
    // 不留兜底快照，永久备份是迁移尝试之前那份字节
    expect(existsSync(preMigrateSnapshotPath(dbFile))).toBe(false);
    expect(existsSync(`${dbFile}${LEGACY_BACKUP_SUFFIX}`)).toBe(true);
  });

  it('半迁移库导入后再打开是空转：不重复导入、不重复写标记', async () => {
    const dbFile = join(state.userData, DB_FILE);
    buildHalfMigratedDb(dbFile, '0026_story');

    let module = await openApp();
    module.getDb();
    await flushAsync();
    const raw = module.getRawDb();
    const counts = {
      campaign: countOf(raw, `SELECT count(*) AS n FROM campaign`),
      node: countOf(raw, `SELECT count(*) AS n FROM knowledge_node`),
      marker: countOf(raw, `SELECT count(*) AS n FROM sync_meta WHERE key = ?`, LEGACY_IMPORT_MARKER_KEY),
    };
    expect(counts).toEqual({ campaign: 1, node: 1, marker: 1 });
    module.closeDb();

    module = await openApp();
    module.getDb();
    await flushAsync();
    const again = module.getRawDb();
    expect(countOf(again, `SELECT count(*) AS n FROM campaign`)).toBe(counts.campaign);
    expect(countOf(again, `SELECT count(*) AS n FROM knowledge_node`)).toBe(counts.node);
    expect(
      countOf(again, `SELECT count(*) AS n FROM sync_meta WHERE key = ?`, LEGACY_IMPORT_MARKER_KEY),
    ).toBe(1);
    expect(existsSync(preMigrateSnapshotPath(dbFile))).toBe(false);
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
    rmSync(state.userData, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 });
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
    // 旧仓库登记表要跟着导进「软件工程」包声明的 repositories 集合：0029 那条迁移是在空库上
    // 跑的，看不到导入进来的 repo 行（与 0027 的处境一样），导入之后必须补搬一次，
    // 否则升级上来的用户打开「源码」页一个仓库都没有
    const repoRow = raw
      .prepare(
        `SELECT value_json FROM plugin_data
         WHERE plugin_id = 'software-engineering' AND collection = 'repositories' AND key = ?`,
      )
      .get('legacy-repo') as { value_json: string } | undefined;
    expect(repoRow).toBeDefined();
    expect(JSON.parse(repoRow!.value_json)).toEqual({
      id: 'legacy-repo',
      label: 'https://example.com/x.git',
      ready: true,
      url: 'https://example.com/x.git',
      status: 'ready',
    });
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

  it('配对随升级保留：sync_peer 与其共享密钥原样到新库、本机身份不变，面板能报出这台手机', async () => {
    const dbFile = join(state.userData, DB_FILE);
    buildLegacyDb(dbFile);
    addPairedDevice(
      dbFile,
      { deviceId: 'phone-0.6.x', sharedKey: 'shared-key-0.6.x', displayName: '我的手机' },
      { deviceId: 'desktop-0.6.x', displayName: '台式机' },
    );

    const module = await openApp();
    module.getDb();
    await flushAsync();
    const raw = module.getRawDb();

    // 配对行连同共享密钥原样搬进新库
    expect(
      raw
        .prepare(`SELECT display_name, platform, shared_key FROM sync_peer WHERE device_id = 'phone-0.6.x'`)
        .get(),
    ).toEqual({ display_name: '我的手机', platform: 'android', shared_key: 'shared-key-0.6.x' });
    // 本机身份不能被重新生成：换了 deviceId 等于变成一台新设备，对端再也认不出
    expect(raw.prepare(`SELECT value FROM sync_meta WHERE key = 'deviceId'`).get()).toEqual({
      value: 'desktop-0.6.x',
    });

    // 面板刷新的那条查询（sync:status → getSyncStatus → listPeers）必须报出这台手机
    const { listPeers } = await import('../sync/pairing');
    expect(listPeers().map((p) => p.deviceId)).toEqual(['phone-0.6.x']);
    const { getSyncStatus } = await import('../sync/server');
    const status = getSyncStatus();
    expect(status.peers.map((p) => p.deviceId)).toEqual(['phone-0.6.x']);
    // 配对是持久的，不在那一场 5 分钟的扫码会话里——会话一过 pairingActive 就是 false
    expect(status.pairingActive).toBe(false);
  });

  it('配对在第二次打开时是空转：不重复、不丢失', async () => {
    const dbFile = join(state.userData, DB_FILE);
    buildLegacyDb(dbFile);
    addPairedDevice(
      dbFile,
      { deviceId: 'phone-0.6.x', sharedKey: 'shared-key-0.6.x', displayName: '我的手机' },
      { deviceId: 'desktop-0.6.x', displayName: '台式机' },
    );

    let module = await openApp();
    module.getDb();
    await flushAsync();
    const firstRaw = module.getRawDb();
    expect(countOf(firstRaw, `SELECT count(*) AS n FROM sync_peer`)).toBe(1);
    module.closeDb();

    module = await openApp();
    module.getDb();
    await flushAsync();
    const again = module.getRawDb();
    expect(countOf(again, `SELECT count(*) AS n FROM sync_peer`)).toBe(1);
    expect(again.prepare(`SELECT value FROM sync_meta WHERE key = 'deviceId'`).get()).toEqual({
      value: 'desktop-0.6.x',
    });
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
    // 已是最新：不重建、也不留迁移前快照
    expect(existsSync(preMigrateSnapshotPath(dbFile))).toBe(false);
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
    // 全新安装没有可丢的东西：既不建导入备份，也不建迁移前快照
    expect(existsSync(preMigrateSnapshotPath(dbFile))).toBe(false);
  });

  /**
   * 报告里的那份库：多了一张当前 schema 从没听说过的 `app_config`（它只在用户自己的库里
   * 存在）。它必须被跳过并如实汇报，而不是被误当成「待搬的表」——旧实现里
   * `pragma_table_info(?)` 不带 schema，会把挂进来的 legacy 库也搜进去，于是给 app_config
   * 排好了搬行计划，最后撞在 `no such table: main.app_config`，整次升级中止。
   *
   * 同时验证启动路径的全部既有保证：好数据到位、备份逐字节保留、一次性标记写入、再打开空转。
   */
  it('旧库多一张 app_config：升级照常完成，该表被跳过并记进标记，再打开仍是空转', async () => {
    const dbFile = join(state.userData, DB_FILE);
    buildLegacyDb(dbFile);
    addDriftedTables(dbFile, [
      `CREATE TABLE app_config (id text PRIMARY KEY NOT NULL, payload text NOT NULL)`,
      `INSERT INTO app_config (id, payload) VALUES ('theme', 'dark')`,
    ]);
    const originalBytes = readFileSync(dbFile);

    let module = await openApp();
    module.getDb();
    await flushAsync();
    const raw = module.getRawDb();

    // 升级没有被这张表拖垮：好数据照旧到位，新 schema 齐全
    expect(raw.prepare(`SELECT label FROM resume WHERE id = 'legacy-resume'`).get()).toEqual({
      label: '母版简历',
    });
    expect(
      countOf(raw, `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'role_profile'`),
    ).toBe(1);
    // app_config 从未被搬进新库
    expect(
      countOf(raw, `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'app_config'`),
    ).toBe(0);

    // 标记里如实记下「跳过了 app_config」
    const marker = JSON.parse(
      (
        raw.prepare(`SELECT value FROM sync_meta WHERE key = ?`).get(LEGACY_IMPORT_MARKER_KEY) as {
          value: string;
        }
      ).value,
    ) as { skipped: { name: string; reason: string }[] };
    expect(marker.skipped.map((entry) => entry.name)).toEqual(['app_config']);

    // 备份逐字节保留
    expect(readFileSync(`${dbFile}${LEGACY_BACKUP_SUFFIX}`).equals(originalBytes)).toBe(true);

    // 第二次打开空转：标记在位 → 不重复导入，app_config 也不会突然出现
    module.closeDb();
    module = await openApp();
    module.getDb();
    await flushAsync();
    const again = module.getRawDb();
    expect(countOf(again, `SELECT count(*) AS n FROM resume WHERE id = 'legacy-resume'`)).toBe(1);
    expect(
      countOf(again, `SELECT count(*) AS n FROM sync_meta WHERE key = ?`, LEGACY_IMPORT_MARKER_KEY),
    ).toBe(1);
  });
});

/**
 * 库形状漂移：旧库里躺着当前线 schema 从没有过的表。整库导入必须做到——不认识就跳过并
 * 汇报（既不去查它、更不去写它），一张怪表不能把整次升级拖垮，好数据照旧到位。
 */
describe('旧库里有当前 schema 不认识的表（形状漂移）', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openjob-import-drift-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 });
  });

  it('多出的 app_config 表被整表跳过并写进报告，其余数据照常导入', () => {
    const dbFile = join(dir, DB_FILE);
    buildLegacyDb(dbFile);
    addDriftedTables(dbFile, [
      `CREATE TABLE app_config (id text PRIMARY KEY NOT NULL, payload text NOT NULL)`,
      `INSERT INTO app_config (id, payload) VALUES ('theme', 'dark')`,
    ]);
    const originalBytes = readFileSync(dbFile);

    const { raw, report } = importLegacyDatabase({ dbFile, migrationsFolder: MIGRATIONS_DIR });
    try {
      // 只跳过 app_config 一张，原因是「新结构里没有这张表」
      expect(report.skipped).toEqual([
        { name: 'app_config', reason: expect.stringContaining('没有这张表') },
      ]);
      // 其余 0.6.x 表照旧导入，好数据到位
      expect(report.tables.map((table) => table.name)).toContain('resume');
      expect(raw.prepare(`SELECT label FROM resume WHERE id = 'legacy-resume'`).get()).toEqual({
        label: '母版简历',
      });
      // app_config 从没被建出来
      expect(
        countOf(raw, `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'app_config'`),
      ).toBe(0);
      // 标记里如实记录跳过
      const marker = JSON.parse(
        (
          raw.prepare(`SELECT value FROM sync_meta WHERE key = ?`).get(LEGACY_IMPORT_MARKER_KEY) as {
            value: string;
          }
        ).value,
      ) as { skipped: { name: string; reason: string }[] };
      expect(marker.skipped).toEqual([
        { name: 'app_config', reason: expect.stringContaining('没有这张表') },
      ]);
      // 原库（已换成新结构）与备份并存，备份逐字节是升级前那份
      expect(readFileSync(`${dbFile}${LEGACY_BACKUP_SUFFIX}`).equals(originalBytes)).toBe(true);
    } finally {
      raw.close();
    }
  });

  /**
   * 同名、却一列都对不上：当前 schema 里有 `practice_attempt`，旧库里这张同名表的列
   * 全是外来的。它必须整表跳过并汇报原因，而不是硬塞。选它是因为它不在 PLUGIN_ERA_TABLES
   * 里，不会把库误判成「当前线」。
   */
  it('与当前 schema 同名、列却完全对不上的表：跳过并汇报，导入仍完成', () => {
    const dbFile = join(dir, DB_FILE);
    buildLegacyDb(dbFile);
    addDriftedTables(dbFile, [
      `CREATE TABLE practice_attempt (alpha text, beta text)`,
      `INSERT INTO practice_attempt (alpha, beta) VALUES ('x', 'y')`,
    ]);

    const { raw, report } = importLegacyDatabase({ dbFile, migrationsFolder: MIGRATIONS_DIR });
    try {
      expect(report.skipped).toEqual([
        { name: 'practice_attempt', reason: expect.stringContaining('没有对应') },
      ]);
      // 其它表照旧到位，好数据在
      expect(raw.prepare(`SELECT label FROM resume WHERE id = 'legacy-resume'`).get()).toEqual({
        label: '母版简历',
      });
      // 同名异形的表没被搬进来
      expect(countOf(raw, `SELECT count(*) AS n FROM practice_attempt`)).toBe(0);
    } finally {
      raw.close();
    }
  });

  /**
   * 形状看似对得上、数据却塞不进去的表：`practice_attempt` 只提供 `id` 一列，而新结构的
   * `session_id` 是 NOT NULL 且无默认值，搬行必然失败。整表回滚、如实汇报即可——既不能
   * 静默丢弃，也不能让这一张表把其它表的导入一起带崩。
   */
  it('单张表搬行失败：整表回滚并汇报，其它表照常导入', () => {
    const dbFile = join(dir, DB_FILE);
    buildLegacyDb(dbFile);
    addDriftedTables(dbFile, [
      `CREATE TABLE practice_attempt (id text PRIMARY KEY NOT NULL)`,
      `INSERT INTO practice_attempt (id) VALUES ('broken-attempt')`,
    ]);

    const { raw, report } = importLegacyDatabase({ dbFile, migrationsFolder: MIGRATIONS_DIR });
    try {
      // 失败被如实汇报，而不是静默丢弃、更不是整库导入中止
      expect(report.skipped).toEqual([
        { name: 'practice_attempt', reason: expect.stringContaining('复制失败') },
      ]);
      // 那半行没有留下来
      expect(countOf(raw, `SELECT count(*) AS n FROM practice_attempt`)).toBe(0);
      // 好数据照旧到位
      expect(raw.prepare(`SELECT label FROM resume WHERE id = 'legacy-resume'`).get()).toEqual({
        label: '母版简历',
      });
    } finally {
      raw.close();
    }
  });

  it('多张怪表与好数据并存：好数据照旧到位，全部怪表列进报告', () => {
    const dbFile = join(dir, DB_FILE);
    buildLegacyDb(dbFile);
    addDriftedTables(dbFile, [
      // 当前 schema 完全没有的表
      `CREATE TABLE app_config (id text PRIMARY KEY NOT NULL, payload text NOT NULL)`,
      `INSERT INTO app_config (id, payload) VALUES ('theme', 'dark')`,
      // 名字是真实表 task 的前缀，列全不相干
      `CREATE TABLE task_shadow (alpha text, beta text)`,
      `INSERT INTO task_shadow (alpha, beta) VALUES ('a', 'b')`,
      // 一张纯外来的表，和新结构没有任何共同列
      `CREATE TABLE user_profile_cache (nickname text, avatar text)`,
      `INSERT INTO user_profile_cache (nickname, avatar) VALUES ('n', 'a')`,
    ]);

    const { raw, report } = importLegacyDatabase({ dbFile, migrationsFolder: MIGRATIONS_DIR });
    try {
      expect(report.skipped.map((entry) => entry.name).sort()).toEqual([
        'app_config',
        'task_shadow',
        'user_profile_cache',
      ]);
      // 0.6.x 的表照旧全部导入，好数据在位（含改名过的列）
      expect(report.tables.map((table) => table.name)).toEqual(
        expect.arrayContaining(['resume', 'campaign', 'knowledge_node', 'task', 'speech_snippet']),
      );
      expect(raw.prepare(`SELECT name FROM knowledge_node WHERE id = 'legacy-node'`).get()).toEqual({
        name: '后端基础',
      });
      expect(
        raw.prepare(`SELECT material_id FROM task WHERE id = 'legacy-task-readcode'`).get(),
      ).toEqual({ material_id: 'legacy-repo' });
      // 怪表一张都没进新库
      for (const name of ['app_config', 'task_shadow', 'user_profile_cache']) {
        expect(
          countOf(raw, `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`, name),
        ).toBe(0);
      }
    } finally {
      raw.close();
    }
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

describe('迁移失败兜底：恢复迁移前的字节', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openjob-premigrate-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * 快照 → 库里被写坏（模拟一次跑了一半的迁移）→ 恢复：字节要回到尝试之前，快照清掉。
   * 这是兜底能救回半迁移库的前提——getDb 在 importLegacyDatabase 之前做的正是这一步。
   */
  it('快照能把原库恢复成迁移尝试之前的字节，并把临时快照清掉', () => {
    const dbFile = join(dir, DB_FILE);
    buildHalfMigratedDb(dbFile, '0026_story');
    const before = readFileSync(dbFile);

    const snapshot = snapshotBeforeMigrate(dbFile);
    expect(snapshot).toBe(preMigrateSnapshotPath(dbFile));
    expect(existsSync(snapshot)).toBe(true);
    expect(readFileSync(snapshot).equals(before)).toBe(true);

    // 模拟一次失败的迁移在库里留下的改动
    const mutated = new Database(dbFile);
    mutated.exec(`CREATE TABLE half_attempted (id text PRIMARY KEY)`);
    mutated.close();
    expect(readFileSync(dbFile).equals(before)).toBe(false);

    restorePreMigrateSnapshot(dbFile);
    // 逐字节回到尝试之前；快照（含可能的 -wal/-shm）都清掉了
    expect(readFileSync(dbFile).equals(before)).toBe(true);
    expect(existsSync(preMigrateSnapshotPath(dbFile))).toBe(false);
    expect(existsSync(`${preMigrateSnapshotPath(dbFile)}-wal`)).toBe(false);
    expect(existsSync(`${preMigrateSnapshotPath(dbFile)}-shm`)).toBe(false);
  });

  it('快照丢失时恢复会抛错，而不是返回一个半调子的文件', () => {
    const dbFile = join(dir, DB_FILE);
    buildHalfMigratedDb(dbFile, '0026_story');
    expect(() => restorePreMigrateSnapshot(dbFile)).toThrow(/快照不存在/);
  });

  /**
   * 兜底在导入这一步也失败时：启动链照旧按「打开失败」处理，但磁盘上必须留着
   * 原始文件（已恢复到迁移前的字节）和永久备份，用户据此能找回数据。
   */
  it('恢复之后整库导入也失败：原库仍是迁移前的字节、备份已在', () => {
    const dbFile = join(dir, DB_FILE);
    buildHalfMigratedDb(dbFile, '0026_story');
    const before = readFileSync(dbFile);

    // 先按 getDb 的顺序走一遍：快照 → 迁移把库写坏 → 恢复
    snapshotBeforeMigrate(dbFile);
    const mutated = new Database(dbFile);
    mutated.exec(`CREATE TABLE half_attempted (id text PRIMARY KEY)`);
    mutated.close();
    restorePreMigrateSnapshot(dbFile);

    // 导入指向不存在的迁移目录 → LegacyImportError
    expect(() =>
      importLegacyDatabase({ dbFile, migrationsFolder: join(dir, 'no-such-migrations') }),
    ).toThrow(LegacyImportError);

    expect(readFileSync(dbFile).equals(before)).toBe(true);
    expect(existsSync(`${dbFile}${LEGACY_BACKUP_SUFFIX}`)).toBe(true);
  });
});
