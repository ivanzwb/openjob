/**
 * 手机端应用对端变更的外键安全测试。
 *
 * 与桌面端 src/main/sync/apply.fk.test.ts 同源的问题：planMerge 逐行独立
 * 决策，同一批变更里可能出现「insert 新建父行 + patch 把子行改挂到它」。
 * 两端 apply 都必须保证 patch 等父行落库后再执行，否则 foreign_keys = ON
 * 下整批事务回滚，同步页报 FOREIGN KEY constraint failed。
 */
import { DatabaseSync } from 'node:sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../db/migrations/bundle';
import { applyAutoChanges } from './apply';
import { partitionRepoFileChanges } from './repoFilePartition';
import { installSyncTriggers } from './triggers';

const LOCAL_DEVICE = 'device-local';
const PEER_DEVICE = 'device-peer';

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

function freshDb(): SQLiteDatabase {
  const raw = adapt(new DatabaseSync(':memory:'));
  raw.execSync('PRAGMA foreign_keys = ON');

  for (const sql of MIGRATIONS) {
    for (const stmt of sql.split('--> statement-breakpoint')) {
      const trimmed = stmt.trim();
      if (trimmed) raw.execSync(trimmed);
    }
  }

  raw.runSync(`INSERT INTO sync_meta (key, value) VALUES ('writeAs', ?)`, LOCAL_DEVICE);
  return raw;
}

function seedCampaign(raw: SQLiteDatabase, id = 'c1'): void {
  raw.runSync(
    `INSERT INTO campaign (id, company, role_title, jd_raw, status, created_at, updated_at)
     VALUES (?, 'ACME', 'SRE', 'jd', 'planning', 1, 1)`,
    id,
  );
}

function insertNode(raw: SQLiteDatabase, id: string, name: string): void {
  raw.runSync(
    `INSERT INTO knowledge_node (id, campaign_id, name, kind, coverage_type, created_at)
     VALUES (?, 'c1', ?, 'concept', 'core', ?)`,
    id,
    name,
    Date.now(),
  );
}

describe('手机端应用变更的外键安全', () => {
  let raw: SQLiteDatabase;

  beforeEach(() => {
    raw = freshDb();
    installSyncTriggers(raw, LOCAL_DEVICE);
    seedCampaign(raw);
  });

  it('patch 改挂到同批 insert 的新父行——patch 必须等父行落库后再执行', () => {
    insertNode(raw, 'n1', 'TCP');

    expect(() =>
      applyAutoChanges(raw, PEER_DEVICE, [
        {
          table: 'knowledge_node',
          rowId: 'n1',
          kind: 'patch',
          values: { campaign_id: 'c2' },
          wallMs: 2000,
        },
        {
          table: 'campaign',
          rowId: 'c2',
          kind: 'insert',
          values: {
            company: 'NEWCO',
            role_title: 'Backend',
            jd_raw: 'jd',
            status: 'planning',
            created_at: 1000,
            updated_at: 1000,
          },
          wallMs: 1000,
        },
      ]),
    ).not.toThrow();

    const row = raw.getFirstSync<{ campaign_id: string }>(
      `SELECT campaign_id FROM knowledge_node WHERE id = 'n1'`,
    );
    expect(row?.campaign_id).toBe('c2');
  });

  it('insert 仍然父表在前——子行随父行同批到达时能整批落库', () => {
    expect(() =>
      applyAutoChanges(raw, PEER_DEVICE, [
        {
          table: 'knowledge_node',
          rowId: 'n9',
          kind: 'insert',
          values: {
            campaign_id: 'c2',
            name: 'QUIC',
            kind: 'concept',
            coverage_type: 'core',
            created_at: 1000,
          },
          wallMs: 2000,
        },
        {
          table: 'campaign',
          rowId: 'c2',
          kind: 'insert',
          values: {
            company: 'NEWCO',
            role_title: 'Backend',
            jd_raw: 'jd',
            status: 'planning',
            created_at: 1000,
            updated_at: 1000,
          },
          wallMs: 1000,
        },
      ]),
    ).not.toThrow();

    const n = raw.getFirstSync<{ n: number }>(`SELECT count(*) AS n FROM knowledge_node`);
    expect(n?.n).toBe(1);
  });

  it('delete 仍然子表在前——删父行前先清掉引用它的子行', () => {
    insertNode(raw, 'n1', 'TCP');

    expect(() =>
      applyAutoChanges(raw, PEER_DEVICE, [
        { table: 'campaign', rowId: 'c1', kind: 'delete', values: {}, wallMs: 3000 },
        { table: 'knowledge_node', rowId: 'n1', kind: 'delete', values: {}, wallMs: 3000 },
      ]),
    ).not.toThrow();

    const n = raw.getFirstSync<{ n: number }>(`SELECT count(*) AS n FROM knowledge_node`);
    expect(n?.n).toBe(0);
  });

  it('JSON 数组列须先序列化，不能把 JS 数组直接绑给 SQLite', () => {
    expect(() =>
      applyAutoChanges(raw, PEER_DEVICE, [
        {
          table: 'design_case',
          rowId: 'dc1',
          kind: 'insert',
          values: {
            campaign_id: 'c1',
            requested_type: 'selfIntro',
            interview_type: 'selfIntro',
            related_node_name: null,
            title: '自我介绍',
            scenario_md: '请做自我介绍',
            constraints: ['60-90 秒', '岗位匹配'],
            evaluation_criteria: ['表达自然'],
            user_answer_md: null,
            recommended_answer_md: null,
            created_at: 1,
            updated_at: 1,
          },
          wallMs: 1,
        },
      ]),
    ).not.toThrow();

    const row = raw.getFirstSync<{ constraints: string }>(
      `SELECT constraints FROM design_case WHERE id = 'dc1'`,
    );
    expect(JSON.parse(row!.constraints)).toEqual(['60-90 秒', '岗位匹配']);
  });

  const campaignInsert = {
    table: 'campaign',
    rowId: 'c1',
    kind: 'insert' as const,
    values: {
      company: 'ACME',
      role_title: 'SRE',
      jd_raw: 'jd',
      jd_parsed: null,
      resume_id: null,
      interview_date: null,
      daily_minutes: null,
      status: 'interviewing',
      created_at: 1,
      updated_at: 2,
    },
    wallMs: 2000,
  };

  it('对已存在的父行下发 insert，不能连带删掉它的子行', () => {
    insertNode(raw, 'n1', 'TCP');

    // planMerge 不查库：对端改过、本机没动过的行一律发成 insert，
    // 哪怕本机早就有这一行。落库时必须是就地更新，不能删了再插。
    applyAutoChanges(raw, PEER_DEVICE, [campaignInsert]);

    const nodes = raw.getFirstSync<{ n: number }>(`SELECT count(*) AS n FROM knowledge_node`);
    expect(nodes?.n).toBe(1);
    const campaign = raw.getFirstSync<{ status: string }>(
      `SELECT status FROM campaign WHERE id = 'c1'`,
    );
    expect(campaign?.status).toBe('interviewing');
  });

  it('同批里父行 insert + 引用旧子行的孙行 insert——旧子行不能被冲掉', () => {
    insertNode(raw, 'n1', 'TCP');

    expect(() =>
      applyAutoChanges(raw, PEER_DEVICE, [
        campaignInsert,
        {
          table: 'explanation',
          rowId: 'e1',
          kind: 'insert',
          values: {
            node_id: 'n1',
            tier: 'spoken',
            content_md: '三次握手',
            model_used: 'test',
            source_ids: [],
            created_at: 1,
          },
          wallMs: 2000,
        },
      ]),
    ).not.toThrow();

    const row = raw.getFirstSync<{ node_id: string }>(
      `SELECT node_id FROM explanation WHERE id = 'e1'`,
    );
    expect(row?.node_id).toBe('n1');
  });

  it('repo_file 删除须跟 repo 同批排序，partition 不能先把 repo 删了', () => {
    raw.runSync(
      `INSERT INTO repo (id, url, local_path, languages, status)
       VALUES ('r1', 'https://github.com/acme/app', '/tmp/app', '[]', 'indexed')`,
    );
    raw.runSync(
      `INSERT INTO repo_file (id, repo_id, file_path, content, line_count, byte_size, updated_at)
       VALUES ('rf1', 'r1', 'main.go', 'package main', 1, 12, 1)`,
    );

    const changes = [
      { table: 'repo', rowId: 'r1', kind: 'delete' as const, values: {}, wallMs: 3000 },
      { table: 'repo_file', rowId: 'rf1', kind: 'delete' as const, values: {}, wallMs: 3000 },
    ];
    const { other, repoFile } = partitionRepoFileChanges(changes);
    expect(repoFile.length).toBe(0);
    expect(other.length).toBe(2);

    expect(() => applyAutoChanges(raw, PEER_DEVICE, other)).not.toThrow();

    const files = raw.getFirstSync<{ n: number }>(`SELECT count(*) AS n FROM repo_file`);
    const repos = raw.getFirstSync<{ n: number }>(`SELECT count(*) AS n FROM repo`);
    expect(files?.n).toBe(0);
    expect(repos?.n).toBe(0);
  });
});
