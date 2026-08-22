import type { SQLiteDatabase } from 'expo-sqlite';

/**
 * 迁移日志与 bundle 不同步、或旧版 JS 未含新迁移时，用 IF NOT EXISTS 补齐关键表。
 * 避免 hydrateAppSettingsFromDb / 同步落库时报 no such table。
 */
export function ensureCriticalSchema(sqlite: SQLiteDatabase): void {
  sqlite.execSync(`
    CREATE TABLE IF NOT EXISTS app_setting (
      id text PRIMARY KEY NOT NULL,
      config_json text NOT NULL,
      secrets_json text DEFAULT '{}' NOT NULL,
      updated_at integer NOT NULL
    );
  `);

  sqlite.execSync(`
    CREATE TABLE IF NOT EXISTS repo_file (
      id text PRIMARY KEY NOT NULL,
      repo_id text NOT NULL,
      file_path text NOT NULL,
      content text NOT NULL,
      line_count integer NOT NULL,
      byte_size integer NOT NULL,
      updated_at integer NOT NULL,
      FOREIGN KEY (repo_id) REFERENCES repo(id) ON UPDATE no action ON DELETE cascade
    );
  `);

  sqlite.execSync(
    `CREATE INDEX IF NOT EXISTS idx_repo_file_repo ON repo_file (repo_id);`,
  );
  sqlite.execSync(
    `CREATE INDEX IF NOT EXISTS idx_repo_file_path ON repo_file (repo_id, file_path);`,
  );

  sqlite.execSync(`
    CREATE TABLE IF NOT EXISTS job_target (
      id text PRIMARY KEY NOT NULL,
      company text NOT NULL,
      role_title text NOT NULL,
      jd_raw text NOT NULL,
      jd_parsed text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    );
  `);
  sqlite.execSync(
    `CREATE INDEX IF NOT EXISTS idx_job_target_company ON job_target (company, role_title);`,
  );

  sqlite.execSync(`
    CREATE TABLE IF NOT EXISTS resume_variant (
      id text PRIMARY KEY NOT NULL,
      source_resume_id text,
      job_target_id text NOT NULL,
      label text NOT NULL,
      content_md text NOT NULL,
      changelog_md text DEFAULT '' NOT NULL,
      is_user_edited integer DEFAULT 0 NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      FOREIGN KEY (source_resume_id) REFERENCES resume(id) ON UPDATE no action ON DELETE set null,
      FOREIGN KEY (job_target_id) REFERENCES job_target(id) ON UPDATE no action ON DELETE cascade
    );
  `);
  sqlite.execSync(
    `CREATE INDEX IF NOT EXISTS idx_resume_variant_target ON resume_variant (job_target_id);`,
  );
  sqlite.execSync(
    `CREATE INDEX IF NOT EXISTS idx_resume_variant_source ON resume_variant (source_resume_id);`,
  );

  try {
    sqlite.execSync(`ALTER TABLE resume_variant ADD COLUMN preview_style text`);
  } catch {
    // column already exists
  }

  try {
    sqlite.execSync(`ALTER TABLE resume ADD COLUMN preview_style text`);
  } catch {
    // column already exists
  }

  try {
    sqlite.execSync(`ALTER TABLE resume_variant ADD COLUMN photo text`);
  } catch {
    // column already exists
  }

  try {
    sqlite.execSync(`ALTER TABLE resume ADD COLUMN photo text`);
  } catch {
    // column already exists
  }

  sqlite.execSync(`
    CREATE TABLE IF NOT EXISTS design_case (
      id text PRIMARY KEY NOT NULL,
      campaign_id text NOT NULL,
      requested_type text NOT NULL,
      interview_type text NOT NULL,
      related_node_name text,
      title text NOT NULL,
      scenario_md text NOT NULL,
      constraints text DEFAULT '[]' NOT NULL,
      evaluation_criteria text DEFAULT '[]' NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      FOREIGN KEY (campaign_id) REFERENCES campaign(id) ON UPDATE no action ON DELETE cascade
    );
  `);
  sqlite.execSync(
    `CREATE INDEX IF NOT EXISTS idx_design_case_campaign_type ON design_case (campaign_id, requested_type);`,
  );

  ensureLastWriteWinsSchema(sqlite);
}

/**
 * 从"用户裁决冲突"迁移到"后写覆盖"所需的结构调整。
 *
 * 为什么不放在迁移 SQL 里：手机端的迁移是容错重放式的（语句报"已存在"就跳过），
 * 而 SQLite 没有 ALTER TABLE IF EXISTS。一旦某次迁移跑到一半退出，重放时
 * RENAME 会报"表不存在"，这个错不在容错白名单里，会把启动直接打挂。放在这里
 * 靠 sqlite_master 自省判断，重复执行天然安全。
 */
function ensureLastWriteWinsSchema(sqlite: SQLiteDatabase): void {
  sqlite.execSync(`
    CREATE TABLE IF NOT EXISTS sync_row_version (
      table_name text NOT NULL,
      row_id text NOT NULL,
      updated_ms integer NOT NULL,
      PRIMARY KEY(table_name, row_id)
    );
  `);

  if (hasTable(sqlite, 'sync_conflict') && !hasTable(sqlite, 'sync_overwrite')) {
    sqlite.execSync(`DROP INDEX IF EXISTS idx_sync_conflict_run`);
    sqlite.execSync(`ALTER TABLE sync_conflict RENAME TO sync_overwrite`);
  }

  if (hasTable(sqlite, 'sync_overwrite')) {
    if (columnExists(sqlite, 'sync_overwrite', 'resolution')) {
      sqlite.execSync(`ALTER TABLE sync_overwrite RENAME COLUMN resolution TO kept_side`);
      // 迁移前留下的 'pending' 没有对应语义，当作"保留了本机值"
      sqlite.execSync(
        `UPDATE sync_overwrite SET kept_side = 'local' WHERE kept_side NOT IN ('local', 'remote')`,
      );
    }
    sqlite.execSync(
      `CREATE INDEX IF NOT EXISTS idx_sync_overwrite_run ON sync_overwrite (run_id);`,
    );
  }

  if (hasTable(sqlite, 'sync_run')) {
    if (columnExists(sqlite, 'sync_run', 'conflict_count')) {
      sqlite.execSync(`ALTER TABLE sync_run RENAME COLUMN conflict_count TO overwrite_count`);
    }
    // 'conflict' 状态不再存在：没有待裁决的东西，这些历史记录一律算完成
    sqlite.execSync(`UPDATE sync_run SET status = 'success' WHERE status = 'conflict'`);
  }

  if (hasTable(sqlite, 'sync_peer') && !columnExists(sqlite, 'sync_peer', 'last_full_sync_at')) {
    sqlite.execSync(`ALTER TABLE sync_peer ADD COLUMN last_full_sync_at integer`);
  }
}

export function hasTable(sqlite: SQLiteDatabase, table: string): boolean {
  const row = sqlite.getFirstSync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    table,
  );
  return Boolean(row?.name);
}

export function columnExists(sqlite: SQLiteDatabase, table: string, column: string): boolean {
  const rows = sqlite.getAllSync<{ name: string }>(`PRAGMA table_info(${table})`);
  return rows.some((r) => r.name === column);
}

export function columnIsNotNull(sqlite: SQLiteDatabase, table: string, column: string): boolean {
  const rows = sqlite.getAllSync<{ name: string; notnull: number }>(`PRAGMA table_info(${table})`);
  return rows.some((r) => r.name === column && r.notnull === 1);
}
