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
