/**
 * 手机端面后复盘的摄入管道。
 *
 * 压在这里的是两件不会自己报错的事：
 *
 * 1. 复盘必须能同步回桌面端。落库靠 writingAs 记 oplog，漏了这层包裹一切照常——
 *    界面显示「已记录」，题目也在手机上看得到，只是桌面端永远收不到。用户第二天
 *    在电脑上复习，图谱里没有任何真题回流的痕迹。
 * 2. 概率修正的幅度必须与桌面端一致。判定取自 @shared/diagnosis/reportIngest，
 *    这里验的是手机端确实按那份规则在改库，而不是自己又算了一套。
 *
 * 用 node:sqlite 跑真迁移而不是伪造 db：管道里十几条语句涉及外键、触发器和
 * 盲区节点的父子关系，用按 SQL 子串分派的假库验不出这些。
 */
import { DatabaseSync } from 'node:sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MIGRATIONS } from '../db/migrations/bundle';
import { CREDIBILITY_WEIGHT, boostedExamProb } from '@shared/diagnosis/reportIngest';

const DEVICE_ID = 'phone-1';

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
vi.mock('../sync/identity', () => ({
  getDeviceIdentity: () => Promise.resolve({ deviceId: 'phone-1' }),
}));
// 这里**不**替掉 ../sync/triggers：writingAs 与真触发器正是本文件要验的东西

const { installSyncTriggers } = await import('../sync/triggers');
const { describeDebriefResult, ingestSelfDebrief } = await import('./debriefLocal');

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

function insertNode(id: string, name: string, examProb: number, campaignId = 'c1'): void {
  db.runSync(
    `INSERT INTO knowledge_node
       (id, campaign_id, parent_id, name, kind, coverage_type, exam_prob, difficulty,
        est_minutes, exam_forms, mastery, mastery_source, priority_score, status, is_user_added, created_at)
     VALUES (?, ?, NULL, ?, 'point', 'deepDive', ?, 3, 30, '["concept"]', 1, 'self', 0, 'todo', 0, 1)`,
    id,
    campaignId,
    name,
    examProb,
  );
}

function examProbOf(id: string): number {
  return db.getFirstSync<{ exam_prob: number }>(
    `SELECT exam_prob FROM knowledge_node WHERE id = ?`,
    id,
  )!.exam_prob;
}

/** 模型两次调用：先抽题，再把题匹配到考点 */
function mockModel(
  questions: string[],
  matches: {
    questionIndex: number;
    nodeName: string | null;
    confidence: number;
    suggestedName?: string | null;
  }[] = [],
): void {
  completeJson.mockReset();
  completeJson.mockImplementation((_profile: string, promptId: string) => {
    if (promptId === 'diagnosis.extractQuestions') return Promise.resolve({ questions });
    if (promptId === 'diagnosis.matchQuestions') return Promise.resolve({ matches });
    throw new Error(`未预期的 prompt：${promptId}`);
  });
}

beforeEach(() => {
  db = adapt(new DatabaseSync(':memory:'));
  db.execSync('PRAGMA foreign_keys = ON');
  for (const sql of MIGRATIONS) {
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) db.execSync(statement);
    }
  }

  // 身份写在 sync_meta 里，getDeviceIdentity 就不会去碰 SecureStore
  db.runSync(`INSERT INTO sync_meta (key, value) VALUES ('deviceId', ?)`, DEVICE_ID);
  db.runSync(`INSERT INTO sync_meta (key, value) VALUES ('displayName', '手机端')`);
  installSyncTriggers(db, DEVICE_ID);

  db.runSync(
    `INSERT INTO campaign (id, company, role_title, jd_raw, status, created_at, updated_at)
     VALUES ('c1', 'ACME', '后端工程师', 'JD 正文', 'planning', 1, 1)`,
  );
  insertNode('n-kafka', 'Kafka 副本同步', 0.4);
  insertNode('n-index', '覆盖索引', 0.3);
});

describe('ingestSelfDebrief', () => {
  it('落一条 selfDebrief 面经，可信度取共享层的满权重', async () => {
    mockModel(['问了副本同步怎么保证不丢消息']);

    const result = await ingestSelfDebrief(db, 'c1', '  二面问了副本同步  ');

    const report = db.getFirstSync<{
      id: string;
      campaign_id: string;
      company: string;
      role_title: string;
      source_type: string;
      raw_text: string;
      credibility_weight: number;
    }>(`SELECT * FROM interview_report`)!;

    expect(report.id).toBe(result.reportId);
    expect(report.source_type).toBe('selfDebrief');
    expect(report.credibility_weight).toBe(CREDIBILITY_WEIGHT.selfDebrief);
    expect(report.campaign_id).toBe('c1');
    expect(report.company).toBe('ACME');
    expect(report.role_title).toBe('后端工程师');
    // 原文两端的空白不该跟着落库
    expect(report.raw_text).toBe('二面问了副本同步');
  });

  it('命中考点时按共享层的幅度抬概率，并标为已匹配', async () => {
    mockModel(
      ['副本同步怎么保证不丢消息'],
      [{ questionIndex: 0, nodeName: 'Kafka 副本同步', confidence: 0.9 }],
    );

    const result = await ingestSelfDebrief(db, 'c1', '二面问了副本同步');

    expect(result.nodesUpdated).toBe(1);
    expect(result.blindSpotsCreated).toBe(0);
    // 自己复盘永远算实证，不吃 0.5 的折扣
    expect(result.corroboratedCount).toBe(1);
    expect(result.unverifiedCount).toBe(0);
    expect(examProbOf('n-kafka')).toBeCloseTo(
      boostedExamProb(0.4, CREDIBILITY_WEIGHT.selfDebrief),
      10,
    );
    // 没被问到的考点不该跟着动
    expect(examProbOf('n-index')).toBe(0.3);

    const question = db.getFirstSync<{
      question_text: string;
      matched_node_id: string | null;
      match_confidence: number | null;
      is_blind_spot: number;
    }>(`SELECT * FROM interview_question`)!;
    expect(question.matched_node_id).toBe('n-kafka');
    expect(question.match_confidence).toBe(0.9);
    expect(question.is_blind_spot).toBe(0);
  });

  /** 图谱没预测到却真被考了的题，信息价值最高，必须留下痕迹 */
  it('匹配不上但模型给了名字时，在真题盲区下建考点', async () => {
    mockModel(
      ['问了事务隔离级别'],
      [{ questionIndex: 0, nodeName: null, confidence: 0.3, suggestedName: '事务隔离级别' }],
    );

    const result = await ingestSelfDebrief(db, 'c1', '还问了事务隔离级别');

    expect(result.blindSpotsCreated).toBe(1);

    const domain = db.getFirstSync<{ id: string; kind: string; coverage_type: string }>(
      `SELECT id, kind, coverage_type FROM knowledge_node WHERE name = '真题盲区'`,
    )!;
    expect(domain.kind).toBe('domain');
    expect(domain.coverage_type).toBe('landmine');

    const point = db.getFirstSync<{
      parent_id: string | null;
      coverage_type: string;
      exam_prob: number;
      is_user_added: number;
    }>(`SELECT * FROM knowledge_node WHERE name = '事务隔离级别'`)!;
    expect(point.parent_id).toBe(domain.id);
    expect(point.coverage_type).toBe('landmine');
    expect(point.is_user_added).toBe(1);

    // 建出来的节点随即被当成命中，题目不再算盲区
    const question = db.getFirstSync<{ matched_node_id: string | null; is_blind_spot: number }>(
      `SELECT * FROM interview_question`,
    )!;
    expect(question.is_blind_spot).toBe(0);
    expect(question.matched_node_id).not.toBeNull();
  });

  it('盲区域只建一次，多道题共用同一个父节点', async () => {
    mockModel(
      ['问了事务隔离级别', '问了 MVCC'],
      [
        { questionIndex: 0, nodeName: null, confidence: 0.3, suggestedName: '事务隔离级别' },
        { questionIndex: 1, nodeName: null, confidence: 0.3, suggestedName: 'MVCC' },
      ],
    );

    const result = await ingestSelfDebrief(db, 'c1', '问了隔离级别和 MVCC');

    expect(result.blindSpotsCreated).toBe(2);
    const domains = db.getAllSync<{ id: string }>(
      `SELECT id FROM knowledge_node WHERE name = '真题盲区'`,
    );
    expect(domains).toHaveLength(1);
  });

  it('既没命中也没建议名时只留题，不动图谱', async () => {
    mockModel(['聊了下职业规划'], [{ questionIndex: 0, nodeName: null, confidence: 0.1 }]);

    const result = await ingestSelfDebrief(db, 'c1', '最后聊了职业规划');

    expect(result.nodesUpdated).toBe(0);
    expect(result.blindSpotsCreated).toBe(0);
    expect(examProbOf('n-kafka')).toBe(0.4);

    const question = db.getFirstSync<{ is_blind_spot: number; matched_node_id: string | null }>(
      `SELECT * FROM interview_question`,
    )!;
    expect(question.is_blind_spot).toBe(1);
    expect(question.matched_node_id).toBeNull();
  });

  it('复盘完这场备考标记为已结束', async () => {
    mockModel(['问了副本同步']);

    await ingestSelfDebrief(db, 'c1', '面完了');

    const campaign = db.getFirstSync<{ status: string }>(
      `SELECT status FROM campaign WHERE id = 'c1'`,
    )!;
    expect(campaign.status).toBe('done');
  });

  /**
   * 这条是整个模块的存在理由：复盘在手机上录，得在电脑上看得到。
   * oplog 里没有本机署名的记录，同步就永远推不出去。
   */
  it('面经、题目与考点改动都记进 oplog，署名本机设备', async () => {
    mockModel(
      ['副本同步怎么保证不丢消息'],
      [{ questionIndex: 0, nodeName: 'Kafka 副本同步', confidence: 0.9 }],
    );

    await ingestSelfDebrief(db, 'c1', '二面问了副本同步');

    const logged = db.getAllSync<{ table_name: string; op: string; device_id: string }>(
      `SELECT table_name, op, device_id FROM sync_oplog`,
    );
    const tables = new Set(logged.map((row) => row.table_name));

    expect(tables.has('interview_report')).toBe(true);
    expect(tables.has('interview_question')).toBe(true);
    expect(tables.has('knowledge_node')).toBe(true);
    expect(tables.has('campaign')).toBe(true);
    // 署名错了会被对端当成回声丢掉
    expect(logged.every((row) => row.device_id === DEVICE_ID)).toBe(true);
  });

  it('同名考点跨备考回流，另一场备考的同一个考点也被抬高', async () => {
    db.runSync(
      `INSERT INTO campaign (id, company, role_title, jd_raw, status, created_at, updated_at)
       VALUES ('c2', 'OTHER', '后端工程师', 'JD', 'planning', 1, 1)`,
    );
    insertNode('n-kafka-c2', 'Kafka 副本同步', 0.2, 'c2');
    mockModel(
      ['副本同步'],
      [{ questionIndex: 0, nodeName: 'Kafka 副本同步', confidence: 0.9 }],
    );

    const result = await ingestSelfDebrief(db, 'c1', '问了副本同步');

    expect(result.crossCampaignUpdated).toBe(1);
    expect(examProbOf('n-kafka-c2')).toBeGreaterThan(0.2);
  });

  it('复盘内容为空时直接拒绝，不调模型也不落空记录', async () => {
    mockModel([]);

    await expect(ingestSelfDebrief(db, 'c1', '   ')).rejects.toThrow('复盘内容为空');
    expect(completeJson).not.toHaveBeenCalled();
    expect(db.getAllSync(`SELECT id FROM interview_report`)).toHaveLength(0);
  });

  /** 抽不出题时没有 questions 可匹配，第二次模型调用就该省掉 */
  it('一道题都没抽出来时不再调匹配，仍留下这次复盘的原文', async () => {
    mockModel([]);

    const result = await ingestSelfDebrief(db, 'c1', '就是随便聊了聊');

    expect(result.questionsExtracted).toBe(0);
    expect(completeJson).toHaveBeenCalledTimes(1);
    expect(db.getAllSync(`SELECT id FROM interview_report`)).toHaveLength(1);
    expect(db.getAllSync(`SELECT id FROM interview_question`)).toHaveLength(0);
  });

  it('模型返回的题目里空白项被丢掉', async () => {
    mockModel(['问了副本同步', '   ', '']);

    const result = await ingestSelfDebrief(db, 'c1', '面完了');

    expect(result.questionsExtracted).toBe(1);
    expect(db.getAllSync(`SELECT id FROM interview_question`)).toHaveLength(1);
  });

  /** 抽题失败时那段口述还在输入框里，重试一次就好；先落库就会留下一条空复盘 */
  it('模型失败时不留下任何记录', async () => {
    completeJson.mockReset();
    completeJson.mockRejectedValue(new Error('网络不可用'));

    await expect(ingestSelfDebrief(db, 'c1', '二面问了副本同步')).rejects.toThrow('网络不可用');

    expect(db.getAllSync(`SELECT id FROM interview_report`)).toHaveLength(0);
    const campaign = db.getFirstSync<{ status: string }>(
      `SELECT status FROM campaign WHERE id = 'c1'`,
    )!;
    expect(campaign.status).toBe('planning');
  });
});

describe('describeDebriefResult', () => {
  const base = {
    reportId: 'r1',
    questionsExtracted: 0,
    nodesUpdated: 0,
    blindSpotsCreated: 0,
    crossCampaignUpdated: 0,
    corroboratedCount: 0,
    unverifiedCount: 0,
  };

  it('一道题都没抽出来时说清楚该补充细节，而不是报「完成」', () => {
    expect(describeDebriefResult(base)).toContain('没能');
  });

  it('盲区单独点出来', () => {
    const message = describeDebriefResult({
      ...base,
      questionsExtracted: 3,
      nodesUpdated: 2,
      blindSpotsCreated: 1,
    });
    expect(message).toContain('3 道题');
    expect(message).toContain('盲区');
  });

  it('跨备考回流为零时不提这一句', () => {
    const message = describeDebriefResult({
      ...base,
      questionsExtracted: 1,
      nodesUpdated: 1,
    });
    expect(message).not.toContain('回流');
  });
});
