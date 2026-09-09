/**
 * 复盘往返闸门：手机上记的面后复盘，同步之后必须变成桌面端图谱里的盲区。
 *
 * 这条链此前是断着测的——手机端只验到「oplog 里有这几张表」，桌面端只验到
 * 「给我一批变更我能落库」，中间那道缝没人站。可这道缝恰恰是最容易坏的地方：
 * 手机新建的盲区节点挂在一个同样是新建的父域下，父子两行必须按正确顺序过外键；
 * 抬概率是 UPDATE，只有 changed_fields 记对了桌面才会跟着改。这些都不会自己报错，
 * 坏掉的表现是「用户第二天在电脑上看不到昨天面试暴露的盲区」。
 *
 * 走的是业务那条缝：手机 collectChangeSet → 共享 planMerge → 桌面 applyAutoChanges。
 * HTTP、配对、预同步备份那一层由 sync/server 与 apply.fk 用例守，这里不重复。
 */
import { DatabaseSync } from 'node:sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BLIND_SPOT_DOMAIN_NAME } from '@shared/diagnosis/reportIngest';
import {
  PHASE1_CAMPAIGN,
  PHASE1_DEBRIEF_MATCHED_NODE_ID,
  PHASE1_DEBRIEF_TEXT,
  PHASE1_NODES,
} from '@shared/plugins/__fixtures__/phase1Campaign';
import { planMerge } from '@shared/syncMerge';
import { MIGRATIONS } from '../db/migrations/bundle';
// 桌面侧一律用真实实现：这条用例的全部价值就在于两端不是同一份代码
import { newLegacyDb } from '../../../src/main/db/__fixtures__/legacyDb';
import { applyAutoChanges } from '../../../src/main/sync/apply';
import { collectChangeSet as collectDesktopChangeSet } from '../../../src/main/sync/collect';
import { buildMergeContext } from '../../../src/main/sync/labels';
import { installSyncTriggers as installDesktopTriggers } from '../../../src/main/sync/triggers';
import type { Database } from 'better-sqlite3';

const PHONE_ID = 'phone-1';
const DESKTOP_ID = 'desktop-1';

/** 复盘里那道没准备到的题，模型给出的盲区命名。 */
const NEW_BLIND_SPOT_NAME = '定价策略与灰度';

const completeJson = vi.hoisted(() => vi.fn());
const ids = vi.hoisted(() => ({ next: 0 }));

vi.mock('../llm/json', () => ({ completeJson }));
// 原生模块在 node 里跑不起来（会把 react-native 的 Flow 源码拖进来）
vi.mock('expo-crypto', () => ({
  randomUUID: () => {
    ids.next += 1;
    return `uuid-${ids.next}`;
  },
}));
vi.mock('expo-secure-store', () => ({}));
vi.mock('./identity', () => ({
  getDeviceIdentity: () => Promise.resolve({ deviceId: PHONE_ID }),
}));

const { installSyncTriggers } = await import('./triggers');
const { collectChangeSet } = await import('./collect');
const { ingestSelfDebrief } = await import('../data/debriefLocal');

/** node:sqlite → expo-sqlite 的适配层，与 debriefLocal.test.ts 同一份 */
function adaptMobile(db: DatabaseSync): SQLiteDatabase {
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

interface NodeRow {
  id: string;
  parent_id: string | null;
  name: string;
  kind: string;
  coverage_type: string;
  exam_prob: number;
}

let phone: SQLiteDatabase;
let desktop: Database;

/** 两端起点相同：同一个产品战役、同一批考点，差异只应由复盘造成。 */
function seedPhone(): void {
  phone.runSync(
    `INSERT INTO campaign (id, company, role_title, jd_raw, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'planning', 1, 1)`,
    PHASE1_CAMPAIGN.id,
    PHASE1_CAMPAIGN.company,
    PHASE1_CAMPAIGN.roleTitle,
    PHASE1_CAMPAIGN.jdRaw,
  );
  for (const node of PHASE1_NODES) {
    phone.runSync(
      `INSERT INTO knowledge_node
         (id, campaign_id, parent_id, name, kind, coverage_type, exam_prob, difficulty,
          est_minutes, exam_forms, mastery, mastery_source, priority_score, status,
          is_user_added, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0.4, ?, ?, ?, 1, 'self', ?, 'todo', 0, 1)`,
      node.id,
      PHASE1_CAMPAIGN.id,
      node.parentId,
      node.name,
      node.kind,
      node.coverageType,
      node.difficulty,
      node.estMinutes,
      JSON.stringify(node.examForms),
      node.priorityScore,
    );
  }
}

function seedDesktop(): void {
  desktop
    .prepare(
      `INSERT INTO campaign (id, company, role_title, jd_raw, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'planning', 1, 1)`,
    )
    .run(
      PHASE1_CAMPAIGN.id,
      PHASE1_CAMPAIGN.company,
      PHASE1_CAMPAIGN.roleTitle,
      PHASE1_CAMPAIGN.jdRaw,
    );
  const insert = desktop.prepare(
    `INSERT INTO knowledge_node
       (id, campaign_id, parent_id, name, kind, coverage_type, exam_prob, difficulty,
        est_minutes, exam_forms, mastery, mastery_source, priority_score, status,
        is_user_added, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0.4, ?, ?, ?, 1, 'self', ?, 'todo', 0, 1)`,
  );
  for (const node of PHASE1_NODES) {
    insert.run(
      node.id,
      PHASE1_CAMPAIGN.id,
      node.parentId,
      node.name,
      node.kind,
      node.coverageType,
      node.difficulty,
      node.estMinutes,
      JSON.stringify(node.examForms),
      node.priorityScore,
    );
  }
}

/** 模型两次调用：先从复盘原文抽题，再把题匹配到考点 */
function mockModel(): void {
  completeJson.mockReset();
  completeJson.mockImplementation((_profile: string, promptId: string) => {
    if (promptId === 'diagnosis.extractQuestions') {
      return Promise.resolve({
        questions: ['北极星指标和护栏指标怎么选', '定价策略怎么做灰度'],
      });
    }
    if (promptId === 'diagnosis.matchQuestions') {
      return Promise.resolve({
        matches: [
          { questionIndex: 0, nodeName: '北极星指标与护栏指标', confidence: 0.9 },
          // 匹配不上：桌面端该看到一个新建出来的盲区，而不是这道题被丢掉
          {
            questionIndex: 1,
            nodeName: null,
            confidence: 0.2,
            suggestedName: NEW_BLIND_SPOT_NAME,
          },
        ],
      });
    }
    throw new Error(`未预期的 prompt：${promptId}`);
  });
}

/** 把手机端自复盘以来的全部变更同步到桌面端，返回实际落库条数。 */
function syncPhoneToDesktop(): { applied: number; skipped: number } {
  const remote = collectChangeSet(phone, PHONE_ID, 0);
  // 桌面侧的变更集也走真实采集：起点取自己的水位，表示这一轮它没有待推的改动。
  // 手写一个空 ChangeSet 字面量会在协议加字段时静默失真
  const head = (
    desktop.prepare(`SELECT coalesce(max(seq), 0) AS head FROM sync_oplog`).get() as {
      head: number;
    }
  ).head;
  const local = collectDesktopChangeSet(desktop, DESKTOP_ID, head);

  const plan = planMerge(local, remote, buildMergeContext(0));
  const out = applyAutoChanges(desktop, PHONE_ID, plan.auto);
  return { applied: out.applied, skipped: out.skipped.length };
}

function desktopNodes(): NodeRow[] {
  return desktop
    .prepare(
      `SELECT id, parent_id, name, kind, coverage_type, exam_prob
       FROM knowledge_node WHERE campaign_id = ? ORDER BY name`,
    )
    .all(PHASE1_CAMPAIGN.id) as NodeRow[];
}

beforeEach(() => {
  ids.next = 0;

  phone = adaptMobile(new DatabaseSync(':memory:'));
  phone.execSync('PRAGMA foreign_keys = ON');
  for (const sql of MIGRATIONS) {
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) phone.execSync(statement);
    }
  }
  // 身份写在 sync_meta 里，getDeviceIdentity 就不会去碰 SecureStore
  phone.runSync(`INSERT INTO sync_meta (key, value) VALUES ('deviceId', ?)`, PHONE_ID);
  phone.runSync(`INSERT INTO sync_meta (key, value) VALUES ('displayName', '手机端')`);
  installSyncTriggers(phone, PHONE_ID);
  seedPhone();

  desktop = newLegacyDb();
  desktop.prepare(`INSERT INTO sync_meta (key, value) VALUES ('deviceId', ?)`).run(DESKTOP_ID);
  desktop.prepare(`INSERT INTO sync_meta (key, value) VALUES ('displayName', ?)`).run('桌面端');
  installDesktopTriggers(desktop, DESKTOP_ID);
  seedDesktop();

  mockModel();
});

describe('面后复盘的跨端往返', () => {
  it('手机记的复盘同步后，桌面端长出同一个盲区考点', async () => {
    await ingestSelfDebrief(phone, PHASE1_CAMPAIGN.id, PHASE1_DEBRIEF_TEXT);

    const before = desktopNodes();
    expect(before.map((node) => node.name)).not.toContain(NEW_BLIND_SPOT_NAME);

    const { applied, skipped } = syncPhoneToDesktop();
    expect(skipped).toBe(0);
    expect(applied).toBeGreaterThan(0);

    const after = desktopNodes();
    const domain = after.find((node) => node.name === BLIND_SPOT_DOMAIN_NAME);
    const point = after.find((node) => node.name === NEW_BLIND_SPOT_NAME);

    // 父子两行都必须到位：只到了子行说明外键顺序错了，只到了父域说明题目被丢了
    expect(domain).toMatchObject({ kind: 'domain', coverage_type: 'landmine' });
    expect(point).toMatchObject({ kind: 'point', coverage_type: 'landmine' });
    expect(point?.parent_id).toBe(domain?.id);
  });

  it('同步过去的盲区节点 id 与手机端逐字相同，不是各自新建一份', async () => {
    await ingestSelfDebrief(phone, PHASE1_CAMPAIGN.id, PHASE1_DEBRIEF_TEXT);
    syncPhoneToDesktop();

    const phoneIds = phone
      .getAllSync<{ id: string; name: string }>(
        `SELECT id, name FROM knowledge_node WHERE campaign_id = ? ORDER BY name`,
        PHASE1_CAMPAIGN.id,
      )
      .map((node) => `${node.name}:${node.id}`);
    const desktopIds = desktopNodes().map((node) => `${node.name}:${node.id}`);

    // id 对不上就意味着两端各建了一份，之后任何一端的修改都同步不到另一端
    expect(desktopIds).toEqual(phoneIds);
  });

  it('已有考点的考中概率被抬到桌面端，而不是只在手机上变高', async () => {
    const baseline = desktop
      .prepare(`SELECT exam_prob FROM knowledge_node WHERE id = ?`)
      .get(PHASE1_DEBRIEF_MATCHED_NODE_ID) as { exam_prob: number };

    await ingestSelfDebrief(phone, PHASE1_CAMPAIGN.id, PHASE1_DEBRIEF_TEXT);
    const onPhone = phone.getFirstSync<{ exam_prob: number }>(
      `SELECT exam_prob FROM knowledge_node WHERE id = ?`,
      PHASE1_DEBRIEF_MATCHED_NODE_ID,
    )!;
    expect(onPhone.exam_prob).toBeGreaterThan(baseline.exam_prob);

    syncPhoneToDesktop();

    const onDesktop = desktop
      .prepare(`SELECT exam_prob FROM knowledge_node WHERE id = ?`)
      .get(PHASE1_DEBRIEF_MATCHED_NODE_ID) as { exam_prob: number };
    // UPDATE 类变更靠 changed_fields 才会被带过去，漏了这里就只是手机上变高
    expect(onDesktop.exam_prob).toBe(onPhone.exam_prob);
  });

  it('面经与真题原文一并到达，桌面端能追到盲区是哪一场面试暴露的', async () => {
    await ingestSelfDebrief(phone, PHASE1_CAMPAIGN.id, PHASE1_DEBRIEF_TEXT);
    syncPhoneToDesktop();

    const report = desktop
      .prepare(
        `SELECT id, source_type, raw_text FROM interview_report WHERE campaign_id = ?`,
      )
      .get(PHASE1_CAMPAIGN.id) as { id: string; source_type: string; raw_text: string };
    expect(report.source_type).toBe('selfDebrief');
    expect(report.raw_text).toContain('定价策略');

    const questions = desktop
      .prepare(
        `SELECT q.question_text, q.matched_node_id, n.name AS node_name
         FROM interview_question q
         LEFT JOIN knowledge_node n ON n.id = q.matched_node_id
         WHERE q.report_id = ? ORDER BY q.question_text`,
      )
      .all(report.id) as {
      question_text: string;
      matched_node_id: string | null;
      node_name: string | null;
    }[];

    expect(questions).toHaveLength(2);
    // 两道题都挂到了桌面端真实存在的考点上：一道命中原有考点，一道命中新建的盲区。
    // 外键指向一个没同步过来的 id 时这条 join 会取到 null
    expect(questions.map((question) => question.node_name).sort()).toEqual(
      ['北极星指标与护栏指标', NEW_BLIND_SPOT_NAME].sort(),
    );
  });

  it('同一批变更再同步一次不会长出第二份盲区', async () => {
    await ingestSelfDebrief(phone, PHASE1_CAMPAIGN.id, PHASE1_DEBRIEF_TEXT);
    syncPhoneToDesktop();
    const once = desktopNodes();

    // 回包丢了、手机按同一个水位重发，是同步里最常见的一种重试
    syncPhoneToDesktop();

    expect(desktopNodes()).toEqual(once);
  });
});
