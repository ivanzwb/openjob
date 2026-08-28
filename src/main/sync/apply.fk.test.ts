/**
 * 应用对端变更时的外键安全测试。
 *
 * planMerge 是逐行独立决策的：同一批变更里完全可能出现「insert 新建父行 +
 * patch 把已有子行改挂到这个新父」。应用侧必须保证 patch 执行时它引用的
 * 父行已经存在——foreign_keys = ON 下 SQLite 是逐语句立即检查外键的，
 * 顺序错了就是 FOREIGN KEY constraint failed，整批事务回滚。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAutoChanges } from './apply';
import { syncTableSpecs } from './tables';
import { installSyncTriggers } from './triggers';

const LOCAL_DEVICE = 'device-local';
const PEER_DEVICE = 'device-peer';

const MIGRATIONS_DIR = join(__dirname, '..', 'db', 'migrations');

/** 与 rowVersion.test.ts 相同的 node:sqlite 适配层 */
function adapt(db: DatabaseSync): Database {
  const shim = {
    prepare: (sql: string) => {
      const stmt = db.prepare(sql);
      return {
        get: (...args: unknown[]) => stmt.get(...(args as never[])),
        all: (...args: unknown[]) => stmt.all(...(args as never[])),
        run: (...args: unknown[]) => stmt.run(...(args as never[])),
      };
    },
    exec: (sql: string) => db.exec(sql),
    // better-sqlite3 的 pragma() 是返回行的，fkDiagnostics 靠它读 foreign_key_list，
    // 适配层不能退化成只执行不返回
    pragma: (statement: string) => db.prepare(`PRAGMA ${statement}`).all(),
    transaction:
      (fn: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) => {
        db.exec('BEGIN');
        try {
          const out = fn(...args);
          db.exec('COMMIT');
          return out;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      },
    close: () => db.close(),
  };
  return shim as unknown as Database;
}

function freshDb(): Database {
  const raw = adapt(new DatabaseSync(':memory:'));
  raw.pragma('foreign_keys = ON');

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    for (const stmt of sql.split('--> statement-breakpoint')) {
      const trimmed = stmt.trim();
      if (trimmed) raw.exec(trimmed);
    }
  }

  raw.prepare(`INSERT INTO sync_meta (key, value) VALUES ('writeAs', ?)`).run(LOCAL_DEVICE);
  return raw;
}

function seedCampaign(raw: Database, id = 'c1'): void {
  raw
    .prepare(
      `INSERT INTO campaign (id, company, role_title, jd_raw, status, created_at, updated_at)
       VALUES (?, 'ACME', 'SRE', 'jd', 'planning', 1, 1)`,
    )
    .run(id);
}

function insertNode(raw: Database, id: string, name: string): void {
  raw
    .prepare(
      `INSERT INTO knowledge_node (id, campaign_id, name, kind, coverage_type, created_at)
       VALUES (?, 'c1', ?, 'concept', 'core', ?)`,
    )
    .run(id, name, Date.now());
}

function readyDb(): Database {
  const raw = freshDb();
  installSyncTriggers(raw, LOCAL_DEVICE);
  seedCampaign(raw);
  return raw;
}

describe('应用变更的外键安全', () => {
  let raw: Database;

  beforeEach(() => {
    raw = readyDb();
    // 跳过孤儿时会打诊断日志，测试输出里不需要
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('patch 改挂到同批 insert 的新父行——patch 必须等父行落库后再执行', () => {
    insertNode(raw, 'n1', 'TCP');

    // 对端新建了 campaign c2，并把 n1 挂了过去。planMerge 逐行独立，
    // 这两条会出现在同一批变更里。
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

    const row = raw.prepare(`SELECT campaign_id FROM knowledge_node WHERE id = 'n1'`).get() as {
      campaign_id: string;
    };
    expect(row.campaign_id).toBe('c2');
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

    const n = raw.prepare(`SELECT count(*) AS n FROM knowledge_node WHERE id = 'n9'`).get() as {
      n: number;
    };
    expect(n.n).toBe(1);
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

    // planMerge 不查库：对端改过、本机没动过的行一律发成 insert（见 syncMerge.ts
    // 的 `if (!localRow)`），哪怕本机早就有这一行。落库必须就地更新，
    // 用 INSERT OR REPLACE 会先删冲突行，把子行一起级联带走。
    applyAutoChanges(raw, PEER_DEVICE, [campaignInsert]);

    const nodes = raw.prepare(`SELECT count(*) AS n FROM knowledge_node`).get() as { n: number };
    expect(nodes.n).toBe(1);
    const campaign = raw.prepare(`SELECT status FROM campaign WHERE id = 'c1'`).get() as {
      status: string;
    };
    expect(campaign.status).toBe('interviewing');
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

    const row = raw.prepare(`SELECT node_id FROM explanation WHERE id = 'e1'`).get() as {
      node_id: string;
    };
    expect(row.node_id).toBe('n1');
  });

  it('delete 仍然子表在前——删父行前先清掉引用它的子行', () => {
    insertNode(raw, 'n1', 'TCP');
    installSyncTriggers(raw, LOCAL_DEVICE);

    expect(() =>
      applyAutoChanges(raw, PEER_DEVICE, [
        { table: 'campaign', rowId: 'c1', kind: 'delete', values: {}, wallMs: 3000 },
        { table: 'knowledge_node', rowId: 'n1', kind: 'delete', values: {}, wallMs: 3000 },
      ]),
    ).not.toThrow();

    const n = raw.prepare(`SELECT count(*) AS n FROM knowledge_node`).get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('defer_foreign_keys 确实生效：事务中途允许子行先于父行落库', () => {
    // apply 的外键安全现在建立在这个 pragma 上，如果哪天它变成空操作，
    // 排序里的任何疏漏都会重新变成用户可见的同步失败——所以直接验证语义。
    expect(() => {
      raw.exec('BEGIN');
      raw.exec('PRAGMA defer_foreign_keys = ON');
      raw.exec(
        `INSERT INTO knowledge_node (id, campaign_id, name, kind, coverage_type, created_at)
         VALUES ('nX', 'cX', 'QUIC', 'concept', 'core', 1)`,
      );
      raw.exec(
        `INSERT INTO campaign (id, company, role_title, jd_raw, status, created_at, updated_at)
         VALUES ('cX', 'NEWCO', 'Backend', 'jd', 'planning', 1, 1)`,
      );
      raw.exec('COMMIT');
    }).not.toThrow();

    const row = raw.prepare(`SELECT campaign_id FROM knowledge_node WHERE id = 'nX'`).get() as {
      campaign_id: string;
    };
    expect(row.campaign_id).toBe('cX');
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
    const n = raw.prepare(`SELECT count(*) AS n FROM explanation`).get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('会话已删除、对端把它的消息按 insert 复活——消息被跳过，会话保持删除', () => {
    // 演练用户报的「FOREIGN KEY constraint failed | message.session_id -> session」。
    // 本机删除过会话 s1（planMerge 判会话删、本批没有它的 insert），对端却有
    // 更晚更新的 6 条消息，按逐行 LWW 被复活成 insert。父行本机不存在、本批也
    // 没有：修复前整批回滚、水位不动、每轮重试都卡死在这 6 条上。修复后这 6 条
    // 被跳过，同步继续收敛——会话已删，它的消息不该被复活回来。
    raw
      .prepare(
        `INSERT INTO session (id, campaign_id, kind, title, created_at)
         VALUES ('s1', 'c1', 'chat', '已删会话', 1000)`,
      )
      .run();
    // 本机删掉会话（级联清消息），与 planMerge 的删除决策一致
    raw.prepare(`DELETE FROM session WHERE id = 's1'`).run();

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
    const count = raw.prepare(`SELECT count(*) AS n FROM message`).get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('本批的 delete 级联带走了同批 insert 的父行——反查必须看删除之后的状态', () => {
    // 批里同时有「删掉 campaign c9」和「插入挂在 c9 名下某个会话上的消息」。
    // 若反查在回滚之后进行，会话还在库里，这条 insert 不会被判成孤儿，重试
    // 依旧是同样的失败——同步继续卡死。只有让删除先落库、再反查，才能看出
    // 会话已经被级联带走。
    raw
      .prepare(
        `INSERT INTO campaign (id, company, role_title, jd_raw, status, created_at, updated_at)
         VALUES ('c9', 'GONE', 'SRE', 'jd', 'planning', 1, 1)`,
      )
      .run();
    raw
      .prepare(
        `INSERT INTO session (id, campaign_id, kind, title, created_at)
         VALUES ('s9', 'c9', 'chat', '会话', 1)`,
      )
      .run();

    const out = applyAutoChanges(raw, PEER_DEVICE, [
      { table: 'campaign', rowId: 'c9', kind: 'delete', values: {}, wallMs: 5000 },
      {
        table: 'message',
        rowId: 'm9',
        kind: 'insert',
        values: {
          session_id: 's9',
          role: 'user',
          content_md: '复活的消息',
          citations: '[]',
          created_at: 1,
        },
        wallMs: 6000,
      },
    ]);

    // 删除照常生效，只有那条消息被跳过
    expect(out.applied).toBe(1);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]).toMatchObject({ table: 'message', rowId: 'm9' });

    const campaigns = raw.prepare(`SELECT count(*) AS n FROM campaign WHERE id = 'c9'`).get() as {
      n: number;
    };
    const messages = raw.prepare(`SELECT count(*) AS n FROM message`).get() as { n: number };
    expect(campaigns.n).toBe(0);
    expect(messages.n).toBe(0);
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
    const n9 = raw.prepare(`SELECT count(*) AS n FROM knowledge_node WHERE id = 'n9'`).get() as {
      n: number;
    };
    expect(n9.n).toBe(1);
    const e1 = raw.prepare(`SELECT count(*) AS n FROM explanation`).get() as { n: number };
    expect(e1.n).toBe(0);
  });

  it('INSERT_ORDER 必须是真实外键的拓扑序——新增表放错位置要当场失败', () => {
    // defer_foreign_keys 之后顺序错了不再报错，问题会藏起来。这条测试直接
    // 拿 schema 里的外键反查同步清单的顺序，把"顺序对不对"从运行时挪到测试里。
    const order = syncTableSpecs().map((s) => s.name);
    const position = new Map(order.map((name, i) => [name, i]));
    const problems: string[] = [];

    for (const [i, table] of order.entries()) {
      const fks = raw.pragma(`foreign_key_list('${table}')`) as { table: string }[];
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
});
