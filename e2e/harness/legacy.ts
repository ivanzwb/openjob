/**
 * 造「旧库」夹具：0.6.x 迁移线与当前线的 SQL 都在仓库里，直接按顺序灌进 SQLite 就行，
 * 不需要启动应用也不需要 drizzle。
 *
 * 为什么不复用 `legacyImport.test.ts` 里的构建器：那是 vitest 里 import TS 的写法，
 * 这里是独立的 Node 进程，直接读 .sql 文件更省事，两边看的是同一份 fixture。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DESKTOP_DIR } from './app';

const LEGACY_06_DIR = join(DESKTOP_DIR, 'src', 'main', 'db', '__fixtures__', 'legacy06');
const MIGRATIONS_DIR = join(DESKTOP_DIR, 'src', 'main', 'db', 'migrations');
/** 当前线走 drizzle 的约定目录，0.6.x 的夹具把 journal 放在自己根下 */
const CURRENT_JOURNAL = join(MIGRATIONS_DIR, 'meta', '_journal.json');
const LEGACY_JOURNAL = join(LEGACY_06_DIR, 'journal.json');

interface JournalEntry {
  tag: string;
  when: number;
}

function journal(file: string): JournalEntry[] {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { entries: JournalEntry[] };
  return raw.entries;
}

function applySqlFile(db: DatabaseSync, file: string): void {
  const sql = readFileSync(file, 'utf8');
  for (const statement of sql.split('--> statement-breakpoint')) {
    if (statement.trim()) db.exec(statement);
  }
}

function logMigration(db: DatabaseSync, sqlPath: string, when: number): void {
  db.prepare(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)`).run(
    createHash('sha256').update(readFileSync(sqlPath, 'utf8')).digest('hex'),
    when,
  );
}

function createMigrationLog(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE __drizzle_migrations (
       id SERIAL PRIMARY KEY,
       hash text NOT NULL,
       created_at numeric
     )`,
  );
}

const T = 1_700_000_000_000;

/** 一份货真价实的 0.6.x 旧库：一条备考 + 简历 + 目标岗位 */
export function buildLegacy06Db(file: string): void {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = OFF');
  const entries = journal(LEGACY_JOURNAL);
  for (const entry of entries) applySqlFile(db, join(LEGACY_06_DIR, `${entry.tag}.sql`));
  createMigrationLog(db);
  for (const entry of entries) logMigration(db, join(LEGACY_06_DIR, `${entry.tag}.sql`), entry.when);

  db.prepare(
    `INSERT INTO resume (id, label, raw_text, parsed, created_at, updated_at, preview_style, photo)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run('legacy-resume', '0.6.x 母版简历', '十年后端经验，做过支付网关。', JSON.stringify({ summary: '后端' }), T, T);
  db.prepare(
    `INSERT INTO job_target (id, company, role_title, jd_raw, jd_parsed, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
  ).run('legacy-target', '旧库示例科技', '后端工程师', '熟悉 MySQL 与分布式。', T, T);
  db.prepare(
    `INSERT INTO campaign (
       id, company, role_title, jd_raw, jd_parsed, resume_id, interview_date,
       daily_minutes, status, created_at, updated_at, job_target_id
     ) VALUES (?, ?, ?, ?, NULL, ?, NULL, 60, 'planning', ?, ?, ?)`,
  ).run(
    'legacy-campaign',
    '旧库示例科技',
    '后端工程师',
    '熟悉 MySQL 与分布式。',
    'legacy-resume',
    T,
    T,
    'legacy-target',
  );
  db.prepare(
    `INSERT INTO knowledge_node (id, campaign_id, name, kind, coverage_type, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('legacy-node', 'legacy-campaign', 'MySQL 索引', 'knowledge', 'deepDive', T);
  db.close();
}

/**
 * 半迁移库：表已经跑到最新，迁移账却被截断到某一条。
 * 这是「迁移撞车 → 回退整库导入」那条路的触发条件。
 */
export function buildHalfMigratedDb(file: string, keepThroughTag: string): void {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = OFF');
  const entries = journal(CURRENT_JOURNAL);
  for (const entry of entries) applySqlFile(db, join(MIGRATIONS_DIR, `${entry.tag}.sql`));
  createMigrationLog(db);
  const cutoff = entries.findIndex((entry) => entry.tag === keepThroughTag);
  if (cutoff < 0) throw new Error(`当前 journal 里没有 ${keepThroughTag}`);
  for (const entry of entries.slice(0, cutoff + 1)) {
    logMigration(db, join(MIGRATIONS_DIR, `${entry.tag}.sql`), entry.when);
  }

  db.prepare(
    `INSERT INTO resume (id, label, raw_text, parsed, created_at, updated_at)
     VALUES ('half-resume', '半迁移简历', '十年后端经验', ?, ?, ?)`,
  ).run(JSON.stringify({ summary: '后端' }), T, T);
  db.prepare(
    `INSERT INTO campaign (id, company, role_title, jd_raw, resume_id, status, created_at, updated_at)
     VALUES ('half-campaign', '半迁移科技', '后端工程师', '熟悉 MySQL', 'half-resume', 'planning', ?, ?)`,
  ).run(T, T);
  db.close();
}

/** 当前 journal 里倒数第 N+1 条的 tag：半迁移用例拿它当截断点 */
export function migrationTag(offsetFromEnd: number): string {
  const entries = journal(CURRENT_JOURNAL);
  const entry = entries[entries.length - 1 - offsetFromEnd];
  if (!entry) throw new Error(`journal 太短，取不到倒数第 ${offsetFromEnd + 1} 条`);
  return entry.tag;
}
