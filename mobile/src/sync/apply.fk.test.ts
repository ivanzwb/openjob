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
import { syncTableSpecs } from './tables';
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

  it('defer_foreign_keys 确实生效：事务中途允许子行先于父行落库', () => {
    // apply 的外键安全现在建立在这个 pragma 上，如果哪天它变成空操作，
    // 排序里的任何疏漏都会重新变成用户可见的同步失败——所以直接验证语义。
    expect(() => {
      raw.execSync('BEGIN');
      raw.execSync('PRAGMA defer_foreign_keys = ON');
      raw.runSync(
        `INSERT INTO knowledge_node (id, campaign_id, name, kind, coverage_type, created_at)
         VALUES ('nX', 'cX', 'QUIC', 'concept', 'core', 1)`,
      );
      raw.runSync(
        `INSERT INTO campaign (id, company, role_title, jd_raw, status, created_at, updated_at)
         VALUES ('cX', 'NEWCO', 'Backend', 'jd', 'planning', 1, 1)`,
      );
      raw.execSync('COMMIT');
    }).not.toThrow();

    const row = raw.getFirstSync<{ campaign_id: string }>(
      `SELECT campaign_id FROM knowledge_node WHERE id = 'nX'`,
    );
    expect(row?.campaign_id).toBe('cX');
  });

  it('孤儿引用不再整批失败——跳过该条并汇报，其余照常落库', () => {
    // 对端发来引用了本机不存在、且本批也没带上的父行。这是 defer_foreign_keys
    // 之后提交时仍会失败的唯一情形。父行既然本机没有、本批也不来，这条变更就
    // 无法落地：跳过它并回报给上层，而不是让整批同步卡死在这一条上——v0.6.17
    // 用户报的 message.session_id -> session(6 行) 就是这种形态。
    const out = applyAutoChanges(raw, PEER_DEVICE, [
      {
        table: 'explanation',
        rowId: 'e1',
        kind: 'insert',
        values: {
          node_id: 'ghost-node',
          tier: 'spoken',
          content_md: '内容',
          model_used: 'test',
          source_ids: [],
          created_at: 1,
        },
        wallMs: 1,
      },
    ]);

    expect(out.applied).toBe(0);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]).toMatchObject({ table: 'explanation', rowId: 'e1' });
    const n = raw.getFirstSync<{ n: number }>(`SELECT count(*) AS n FROM explanation`);
    expect(n?.n).toBe(0);
  });

  it('会话已删除、对端把它的消息按 insert 复活——消息被跳过，会话保持删除', () => {
    // 演练用户报的「FOREIGN KEY constraint failed | message.session_id -> session」。
    // 本机删除过会话 s1（planMerge 判会话删、本批没有它的 insert），对端却有
    // 更晚更新的 6 条消息，按逐行 LWW 被复活成 insert。父行本机不存在、本批也
    // 没有：修复前整批回滚、水位不动、每轮重试都卡死在这 6 条上。修复后这 6 条
    // 被跳过，同步继续收敛——会话已删，它的消息不该被复活回来。
    raw.runSync(
      `INSERT INTO session (id, campaign_id, kind, title, created_at)
       VALUES ('s1', 'c1', 'chat', '已删会话', 1000)`,
    );
    // 本机删掉会话（级联清消息），与 planMerge 的删除决策一致
    raw.runSync(`DELETE FROM session WHERE id = 's1'`);

    const resurrected = Array.from({ length: 6 }, (_, i) => ({
      table: 'message',
      rowId: `m${i + 1}`,
      kind: 'insert' as const,
      values: {
        session_id: 's1',
        role: 'user',
        content_md: `复活的消息 ${i + 1}`,
        citations: '[]',
        created_at: 1000 + i,
      },
      wallMs: 3000 + i,
    }));

    const out = applyAutoChanges(raw, PEER_DEVICE, resurrected);

    expect(out.applied).toBe(0);
    expect(out.skipped).toHaveLength(6);
    const count = raw.getFirstSync<{ n: number }>(`SELECT count(*) AS n FROM message`);
    expect(count?.n).toBe(0);
  });

  it('孤儿与可落库变更混批——坏的被跳过，好的照常应用', () => {
    insertNode(raw, 'n5', 'TCP');

    const out = applyAutoChanges(raw, PEER_DEVICE, [
      {
        table: 'knowledge_node',
        rowId: 'n9',
        kind: 'insert',
        values: {
          campaign_id: 'c1',
          name: 'QUIC',
          kind: 'concept',
          coverage_type: 'core',
          created_at: 1000,
        },
        wallMs: 2000,
      },
      {
        table: 'explanation',
        rowId: 'e1',
        kind: 'insert',
        values: {
          node_id: 'ghost-node',
          tier: 'spoken',
          content_md: '内容',
          model_used: 'test',
          source_ids: [],
          created_at: 1,
        },
        wallMs: 1,
      },
    ]);

    expect(out.applied).toBe(1);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]).toMatchObject({ table: 'explanation', rowId: 'e1' });
    const n9 = raw.getFirstSync<{ n: number }>(
      `SELECT count(*) AS n FROM knowledge_node WHERE id = 'n9'`,
    );
    expect(n9?.n).toBe(1);
    const e1 = raw.getFirstSync<{ n: number }>(`SELECT count(*) AS n FROM explanation`);
    expect(e1?.n).toBe(0);
  });

  it('INSERT_ORDER 必须是真实外键的拓扑序——新增表放错位置要当场失败', () => {
    // defer_foreign_keys 之后顺序错了不再报错，问题会藏起来。这条测试直接
    // 拿 schema 里的外键反查同步清单的顺序，把"顺序对不对"从运行时挪到测试里。
    const order = syncTableSpecs().map((s) => s.name);
    const position = new Map(order.map((name, i) => [name, i]));
    const problems: string[] = [];

    for (const [i, table] of order.entries()) {
      const fks = raw.getAllSync<{ table: string }>(`PRAGMA foreign_key_list('${table}')`);
      for (const fk of fks) {
        const parent = position.get(fk.table);
        if (parent === undefined) {
          problems.push(`${table} 引用了不在同步清单里的 ${fk.table}`);
        } else if (parent > i) {
          problems.push(`${table}(${i}) 排在父表 ${fk.table}(${parent}) 之前`);
        }
      }
    }

    expect(problems).toEqual([]);
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
