/**
 * 旧检出补齐的用例。
 *
 * 盯的是「不许撒谎」这一条：登记行只有在检出**真的**搬进了包工作区时才补 dir，
 * 而补完之后源码页的浏览、重建索引才会跟着可用。任何一种搬不动的理由都必须
 * 保持原样——写一个指不到的 dir 比写着「本机还没有检出」更糟。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { backfillLegacyRepoCheckouts } from './legacyRepoCheckouts';

const REPO_URL = 'https://github.com/example/deepseek-harness.git';
const PLUGIN_ID = 'software-engineering';
const REPO_ID = 'repo-1';

const roots: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  db: Database.Database;
  userData: string;
  /** 旧检出目录（0.6.x 的 `userData/repos/<…>`） */
  legacyDir: string;
  /** 与宿主同一条约定的工作区根：`userData/plugin-workspace/<pluginId>` */
  workspaceRoot(pluginId: string): string;
  workspaceDir(name: string): string;
  entryValue(): Record<string, unknown>;
}

function fixture(options: { legacyPathExists?: boolean; dir?: string; withUrl?: boolean } = {}): Fixture {
  const userData = tempDir('openjob-checkouts-');
  const legacyDir = join(userData, 'repos', 'deepseek-harness-repo-1');
  if (options.legacyPathExists !== false) {
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'README.md'), '# demo\n');
  }

  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE repo (id text PRIMARY KEY, url text, local_path text, status text);
    CREATE TABLE plugin_data (
      id text PRIMARY KEY, plugin_id text, collection text, key text,
      value_json text, updated_at integer
    );
  `);
  db.prepare('INSERT INTO repo (id, url, local_path, status) VALUES (?, ?, ?, ?)').run(
    REPO_ID,
    REPO_URL,
    legacyDir,
    'ready',
  );

  const value: Record<string, unknown> = {
    id: REPO_ID,
    label: REPO_URL,
    ready: true,
    ...(options.withUrl === false ? {} : { url: REPO_URL }),
    status: 'ready',
  };
  if (options.dir) value.dir = options.dir;

  db.prepare(
    `INSERT INTO plugin_data (id, plugin_id, collection, key, value_json, updated_at)
     VALUES (?, ?, 'repositories', ?, ?, 0)`,
  ).run(`${PLUGIN_ID}\u001frepositories\u001f${REPO_ID}`, PLUGIN_ID, REPO_ID, JSON.stringify(value));

  const workspaceRoot = (pluginId: string): string =>
    join(userData, 'plugin-workspace', pluginId);

  return {
    db,
    userData,
    legacyDir,
    workspaceRoot,
    workspaceDir: (name) => join(workspaceRoot(PLUGIN_ID), name),
    entryValue: () =>
      JSON.parse(
        (
          db.prepare("SELECT value_json FROM plugin_data WHERE collection = 'repositories'").get() as {
            value_json: string;
          }
        ).value_json,
      ) as Record<string, unknown>,
  };
}

describe('backfillLegacyRepoCheckouts', () => {
  it('本机存在旧检出时搬进包工作区并补上 dir', () => {
    const f = fixture();

    const result = backfillLegacyRepoCheckouts(f.db, f.workspaceRoot, 1_700_000_000_000);

    expect(result).toEqual({ attached: 1, adopted: 1 });
    // 名字与包在工作区里新拉一份得到的一致，之后「更新到最新」按同一个 dir 走
    expect(f.entryValue().dir).toBe('example-deepseek-harness');
    expect(existsSync(join(f.workspaceDir('example-deepseek-harness'), 'README.md'))).toBe(true);
    // 搬是改名，不是复制：旧目录不再留着同一份内容
    expect(existsSync(f.legacyDir)).toBe(false);
  });

  it('旧检出目录已经不在了就什么都不改', () => {
    const f = fixture({ legacyPathExists: false });

    expect(backfillLegacyRepoCheckouts(f.db, f.workspaceRoot)).toEqual({ attached: 0, adopted: 0 });
    expect(f.entryValue().dir).toBeUndefined();
  });

  it('工作区里同名目录已存在时不碰它，也不改登记行', () => {
    const f = fixture();
    mkdirSync(f.workspaceDir('example-deepseek-harness'), { recursive: true });

    expect(backfillLegacyRepoCheckouts(f.db, f.workspaceRoot)).toEqual({ attached: 0, adopted: 0 });
    expect(f.entryValue().dir).toBeUndefined();
    expect(existsSync(f.legacyDir)).toBe(true);
  });

  it('已经补过 dir 的行不再处理，旧目录原地留着', () => {
    const f = fixture({ dir: 'example-deepseek-harness' });

    expect(backfillLegacyRepoCheckouts(f.db, f.workspaceRoot)).toEqual({ attached: 0, adopted: 0 });
    expect(existsSync(f.legacyDir)).toBe(true);
  });

  it('登记行里没有 url 时不动手（推不出工作区里的名字）', () => {
    const f = fixture({ withUrl: false });

    expect(backfillLegacyRepoCheckouts(f.db, f.workspaceRoot)).toEqual({ attached: 0, adopted: 0 });
    expect(existsSync(f.legacyDir)).toBe(true);
  });

  it('登记行里没有对应的旧 repo 行时跳过', () => {
    const f = fixture({ legacyPathExists: false });
    f.db.prepare('DELETE FROM repo').run();

    expect(backfillLegacyRepoCheckouts(f.db, f.workspaceRoot)).toEqual({ attached: 0, adopted: 0 });
  });
});
