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
}

export function hasTable(sqlite: SQLiteDatabase, table: string): boolean {
  const row = sqlite.getFirstSync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    table,
  );
  return Boolean(row?.name);
}
