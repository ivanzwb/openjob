/**
 * 话术库对 `story` 这个来源类型的解析。
 *
 * speech_snippet.source_type 是一列裸 text，加一个新取值不会有任何编译错误：
 * 两端各自有一处 if/else 在解析它，漏改的那一端只会把这条话术显示成标题「话术」、
 * 归不到任何一场备考下——用户在手机上看到的是一条来路不明的口述稿。
 *
 * 桌面端那一处走 Drizzle 的进程内单例，指不到测试库上；手机端这一处接的是
 * SQLiteDatabase，可以对着真库验，所以两端一致性的回归压在这里。
 */
import { DatabaseSync } from 'node:sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../db/migrations/bundle';
import { listSpeechSnippets } from './queries';

/** 与 migrate.test.ts 相同的 node:sqlite 适配层 */
function adapt(db: DatabaseSync): SQLiteDatabase {
  const shim = {
    execSync: (sql: string) => db.exec(sql),
    runSync: (sql: string, ...args: unknown[]) => db.prepare(sql).run(...(args as never[])),
    getAllSync: (sql: string, ...args: unknown[]) => db.prepare(sql).all(...(args as never[])),
    getFirstSync: (sql: string, ...args: unknown[]) =>
      db.prepare(sql).get(...(args as never[])) ?? null,
    closeSync: () => db.close(),
  };
  return shim as unknown as SQLiteDatabase;
}

let db: SQLiteDatabase;

beforeEach(() => {
  db = adapt(new DatabaseSync(':memory:'));
  db.execSync('PRAGMA foreign_keys = ON');
  for (const sql of MIGRATIONS) {
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) db.execSync(statement);
    }
  }

  db.runSync(
    `INSERT INTO campaign (id, company, role_title, jd_raw, status, created_at, updated_at)
     VALUES ('c1', 'ACME', '后端工程师', 'JD', 'planning', 1, 1)`,
  );
  db.runSync(
    `INSERT INTO story (id, campaign_id, title, situation_md, task_md, action_md, result_md,
                        reflection_md, competency_ids, created_at, updated_at)
     VALUES ('s1', 'c1', '订单履约链路重构', 'S', 'T', 'A', 'R', '', '[]', 1, 1)`,
  );
});

function insertSnippet(id: string, sourceType: string, sourceId: string): void {
  db.runSync(
    `INSERT INTO speech_snippet (id, source_type, source_id, tier, content_md, is_user_edited, created_at)
     VALUES (?, ?, ?, 'spoken', '口述稿', 0, 10)`,
    id,
    sourceType,
    sourceId,
  );
}

describe('story 来源的话术', () => {
  it('来源标题用 Story 自己的标题，并归到它所属的备考下', () => {
    insertSnippet('sp1', 'story', 's1');

    const [snippet] = listSpeechSnippets(db);

    expect(snippet.sourceType).toBe('story');
    expect(snippet.sourceLabel).toBe('经历 · 订单履约链路重构');
    expect(snippet.campaignId).toBe('c1');
    expect(snippet.campaignLabel).toBe('ACME · 后端工程师');
  });

  it('Story 已被删掉的话术不会伪装成别的来源，也不会硬挂到某场备考上', () => {
    // 正常路径下删 Story 会连带删掉它的口述话术；这里守的是同步半途、
    // 或者旧版本留下的孤儿行不会把整个话术库渲染坏。
    insertSnippet('sp2', 'story', 'story-gone');

    const [snippet] = listSpeechSnippets(db);

    expect(snippet.sourceLabel).toBe('经历');
    expect(snippet.campaignId).toBeNull();
    expect(snippet.campaignLabel).toBeNull();
  });
});
