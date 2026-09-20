/**
 * 手机端练习引擎：题型与量规来自同步过来的岗位包，出题/追问/评分写进参与同步的
 * practice_* 表。这里验的是流程与落库（模型那一步单独 mock，JSON 解析由 core 的用例守）。
 */
import { DatabaseSync } from 'node:sqlite';
import {
  softwareEngineeringRolePack,
  SOFTWARE_ENGINEERING_FORMAT_IDS,
} from '@plugins/softwareEngineering';
import type { SQLiteDatabase } from 'expo-sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MIGRATIONS } from '../db/migrations/bundle';
import { ensureCriticalSchema } from '../db/schemaEnsure';
import { PRE_PLUGIN_CAMPAIGN_SCOPE_KIND } from '@core/planner/contributions';

const ids = vi.hoisted(() => ({ next: 0 }));

vi.mock('expo-crypto', () => ({
  randomUUID: () => {
    ids.next += 1;
    return `uuid-${ids.next}`;
  },
}));
vi.mock('expo-secure-store', () => ({}));
vi.mock('../sync/identity', () => ({
  getDeviceIdentity: () => Promise.resolve({ deviceId: 'dev-1' }),
}));
// writingAs 只负责把写入标成本机来源，直接执行回调即可
vi.mock('../sync/triggers', () => ({
  writingAs: (_db: unknown, _id: string, fn: () => void) => fn(),
}));
// 优先级权重用真实默认值：掌握度回写要按同一套公式算分
vi.mock('../config/settings', async () => {
  const { DEFAULT_PRIORITY_WEIGHTS } = await import('@core/config');
  return { getMobileConfig: () => ({ priority: DEFAULT_PRIORITY_WEIGHTS }) };
});
// 候选人上下文要连表读简历，这一组用例只关心练习本身
vi.mock('./candidateContextLocal', () => ({
  loadCandidateContextInput: () => ({ company: 'ACME', roleTitle: '后端工程师' }),
}));
// 模型单独 mock：出题与评分两种请求按 user message 区分
vi.mock('../llm/json', () => ({ completeJsonWithSystem: vi.fn() }));
// rolePackLocal 会 import 到 RN 侧模块（remote/rpc），用例里只关心「本机缓存里有没有这个包」
const state = vi.hoisted(() => ({ cached: true }));
vi.mock('./rolePackLocal', async () => {
  const { softwareEngineeringRolePack } = await import('@plugins/softwareEngineering');
  return {
    getCachedRolePack: (_db: unknown, id: string, version: string) =>
      state.cached &&
      id === softwareEngineeringRolePack.manifest.id &&
      version === softwareEngineeringRolePack.manifest.version
        ? softwareEngineeringRolePack
        : null,
    listCachedRolePacks: () => (state.cached ? [softwareEngineeringRolePack] : []),
  };
});

const { completeJsonWithSystem } = await import('../llm/json');
const { BASELINE_INTERVIEW_FORMATS, CORE_SELF_INTRO_RUBRIC_ID } = await import('@core/practice');
const {
  answerPracticeTurn,
  evaluatePractice,
  practiceAttemptScores,
  practiceFormatOptions,
  resolveCampaignPracticeRuntime,
  startPracticeSession,
} = await import('./practiceLocal');

const PACK = softwareEngineeringRolePack;
const FORMAT_ID = SOFTWARE_ENGINEERING_FORMAT_IDS.knowledge;
const FORMAT = PACK.interviewFormats.find((item) => item.id === FORMAT_ID)!;
const RUBRIC = PACK.rubrics.find((item) => item.id === FORMAT.rubricId)!;
const CAMPAIGN_ID = 'c-1';
const NODE_ID = 'n-1';
const ANSWER_MD = '我用 Kafka 的消费位点配合业务侧去重表来做幂等，重复投递不会产生重复扣款。';
const QUESTION_MD = '请讲讲你线上做幂等的一次经历，说明取舍。';

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

/** 这场战役：有画像、有 descriptor、本机缓存了岗位包，并绑了一个考点。 */
function seed(
  db: SQLiteDatabase,
  options: { cached?: boolean; descriptor?: boolean; prePlugin?: boolean } = {},
): void {
  db.runSync(
    `INSERT INTO role_profile (id, role_family, role_pack_id, level, industry_variant_id, location,
       interview_language, confidence, user_confirmed)
     VALUES ('rp-1', ?, ?, NULL, NULL, NULL, 'zh', 1, 1)`,
    PACK.manifest.id,
    PACK.manifest.id,
  );
  db.runSync(
    `INSERT INTO campaign (id, company, role_title, jd_raw, status, role_profile_id, created_at, updated_at)
     VALUES (?, 'ACME', '后端工程师', 'jd', 'planning', ?, 1, 1)`,
    CAMPAIGN_ID,
    options.prePlugin ? null : 'rp-1',
  );
  if (options.descriptor !== false) {
    db.runSync(
      `INSERT INTO campaign_runtime_descriptor (id, campaign_id, revision, core_version, role_pack,
         industry_variant_id, capabilities, competency_baseline_version, config_snapshot_hash, resolved_at)
       VALUES ('d-1', ?, 1, '1.0.0', ?, NULL, '[]', ?, 'hash-1', 1)`,
      CAMPAIGN_ID,
      JSON.stringify({ id: PACK.manifest.id, version: PACK.manifest.version }),
      PACK.manifest.version,
    );
  }
  if (options.prePlugin) {
    db.runSync(
      `INSERT INTO migration_checkpoint (id, campaign_id, kind, completed_at) VALUES (?, ?, ?, 1)`,
      `prePlugin:${CAMPAIGN_ID}`,
      CAMPAIGN_ID,
      PRE_PLUGIN_CAMPAIGN_SCOPE_KIND,
    );
  }
  if (options.cached !== false) {
    db.runSync(
      `INSERT INTO role_pack_cache (id, version, pack_json, fetched_at) VALUES (?, ?, ?, 1)`,
      PACK.manifest.id,
      PACK.manifest.version,
      JSON.stringify(PACK),
    );
  }
  db.runSync(
    `INSERT INTO knowledge_node (
       id, campaign_id, name, kind, coverage_type, difficulty, est_minutes,
       mastery, priority_score, status, created_at
     ) VALUES (?, ?, '幂等设计', 'point', 'deepDive', 3, 30, 2, 10, 'shaky', 1)`,
    NODE_ID,
    CAMPAIGN_ID,
  );
}

function freshDb(
  options: { cached?: boolean; descriptor?: boolean; prePlugin?: boolean } = {},
): SQLiteDatabase {
  const db = adapt(new DatabaseSync(':memory:'));
  db.execSync('PRAGMA foreign_keys = ON');
  for (const sql of MIGRATIONS) {
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) db.execSync(trimmed);
    }
  }
  // role_pack_cache 是设备本地表，不在同步迁移里，靠 openDb 时的 ensureCriticalSchema 建
  ensureCriticalSchema(db);
  seed(db, options);
  return db;
}

/** 一次完整作答需要的模型输出：题目 / 追问 / 评分各一次。 */
function mockModel(): void {
  vi.mocked(completeJsonWithSystem).mockImplementation(async (_role, _system, user) => {
    if (user.includes('提交评分的作答')) {
      return {
        feedbackMd: '结构清楚，取舍讲到了。',
        improvedScriptMd: '先说结论：用消费位点 + 去重表保证幂等。',
        dimensions: RUBRIC.dimensions.map((dimension) => ({
          dimensionId: dimension.id,
          score: 4,
          answerQuote: ANSWER_MD,
          rationale: '作答里有对应的取舍说明。',
        })),
      };
    }
    return { questionMd: QUESTION_MD };
  });
}

let db: SQLiteDatabase;

beforeEach(() => {
  ids.next = 0;
  state.cached = true;
  vi.mocked(completeJsonWithSystem).mockReset();
  db = freshDb();
});

describe('resolveCampaignPracticeRuntime', () => {
  it('拿 pin 的精确版本去缓存里取包，并带上画像里的面试语言', () => {
    const runtime = resolveCampaignPracticeRuntime(db, CAMPAIGN_ID);

    expect(runtime.rolePack.manifest.id).toBe(PACK.manifest.id);
    expect(runtime.rolePack.manifest.version).toBe(PACK.manifest.version);
    expect(runtime.interviewLanguage).toBe('zh');
    expect(runtime.descriptor.configSnapshotHash).toBe('hash-1');
  });

  it('本机还没取到包时说清是「还没同步到」，而不是笼统报错', () => {
    state.cached = false;
    // 缓存表里也确实没有这一行（同步还没把它带过来）
    const bare = freshDb({ cached: false });

    expect(() => resolveCampaignPracticeRuntime(bare, CAMPAIGN_ID)).toThrow(/岗位包/);
  });

  /**
   * 插件化之前的旧战役没有 descriptor：排程那条路径按本机缓存的岗位包补一份，
   * 练习共用同一个取法，所以老战役在手机端照样练得了，不会被「没有运行配置」挡住。
   */
  it('插件化之前的旧战役没有 descriptor 时，按本机缓存的岗位包补一份', () => {
    const legacy = freshDb({ descriptor: false, prePlugin: true });

    const runtime = resolveCampaignPracticeRuntime(legacy, CAMPAIGN_ID);

    expect(runtime.rolePack.manifest.id).toBe(PACK.manifest.id);
    expect(runtime.descriptor.rolePack.version).toBe(PACK.manifest.version);
  });
});

describe('practiceFormatOptions', () => {
  it('基线题型在前，岗位包声明的题型在后', () => {
    expect(practiceFormatOptions(db, CAMPAIGN_ID).map((option) => option.id)).toEqual([
      ...BASELINE_INTERVIEW_FORMATS.map((format) => format.id),
      ...PACK.interviewFormats.map((format) => format.id),
    ]);
  });

  it('基线题型能在本机开出会话并解析出量规', async () => {
    mockModel();

    const session = await startPracticeSession(db, {
      campaignId: CAMPAIGN_ID,
      formatId: BASELINE_INTERVIEW_FORMATS[0].id,
      nodeId: NODE_ID,
    });

    expect(session.rubricId).toBe(CORE_SELF_INTRO_RUBRIC_ID);
    expect(session.protocol).toBe('presentation');
  });
});

describe('一次完整练习', () => {
  it('出题 → 追问 → 评分：落库、逐维分数可复核、掌握度回写', async () => {
    mockModel();

    const session = await startPracticeSession(db, {
      campaignId: CAMPAIGN_ID,
      formatId: FORMAT_ID,
      nodeId: NODE_ID,
    });

    expect(session.status).toBe('open');
    expect(session.turns).toHaveLength(1);
    expect(session.turns[0]).toMatchObject({ speaker: 'interviewer', kind: 'question' });
    expect(session.turns[0]!.contentMd).toBe(QUESTION_MD);
    expect(session.rolePackVersion).toBe(PACK.manifest.version);

    const turn = await answerPracticeTurn(db, { sessionId: session.id, answerMd: ANSWER_MD });
    expect(turn).toMatchObject({ speaker: 'interviewer', kind: 'followUp' });

    // 追问轮数用尽后由引擎收束，不再问模型
    const closed = await answerPracticeTurn(db, { sessionId: session.id, answerMd: ANSWER_MD });
    expect(closed.kind).toBe('followUp');

    const evaluation = await evaluatePractice(db, { sessionId: session.id });
    expect(evaluation.scores).toHaveLength(RUBRIC.dimensions.length);
    expect(evaluation.totalScore).toBeCloseTo(4, 5);
    expect(evaluation.needsRePractice).toBe(false);

    // 逐维分数连同锚点原文与原文区间一起落库，结果页才复核得了
    const scores = practiceAttemptScores(db, evaluation.attemptId);
    expect(scores).toHaveLength(RUBRIC.dimensions.length);
    for (const score of scores) {
      const dimension = RUBRIC.dimensions.find((item) => item.id === score.dimensionId)!;
      expect(score.score).toBe(4);
      expect(score.anchor.text).toBe(dimension.anchors[4]);
      expect(score.answer).toEqual({ quote: ANSWER_MD, start: 0, end: ANSWER_MD.length });
    }

    const attempt = db.getFirstSync<{ total_score: number; prompt_version_id: string }>(
      `SELECT total_score, prompt_version_id FROM practice_attempt WHERE id = ?`,
      evaluation.attemptId,
    );
    expect(attempt?.total_score).toBeCloseTo(4, 5);
    expect(attempt?.prompt_version_id).not.toBe('');

    const sessionRow = db.getFirstSync<{ status: string }>(
      `SELECT status FROM practice_session WHERE id = ?`,
      session.id,
    );
    expect(sessionRow?.status).toBe('evaluated');

    // 绑了考点就把掌握度回写（来源沿用 'quiz'：MASTERY_SOURCES 是同步字段，不加新值）
    const node = db.getFirstSync<{ mastery: number; mastery_source: string }>(
      `SELECT mastery, mastery_source FROM knowledge_node WHERE id = ?`,
      NODE_ID,
    );
    expect(node?.mastery_source).toBe('quiz');
    expect(node?.mastery).toBeGreaterThan(2);
    expect(evaluation.mastery?.status).toBeDefined();
  });

  it('追问到上限时收束，之后不能再作答', async () => {
    mockModel();
    const session = await startPracticeSession(db, {
      campaignId: CAMPAIGN_ID,
      formatId: FORMAT_ID,
    });

    // 直接把追问轮数用满：SE 的知识问答题型上限是有限的
    for (let round = 0; round < FORMAT.followUpPolicy.maxRounds; round += 1) {
      await answerPracticeTurn(db, { sessionId: session.id, answerMd: ANSWER_MD });
    }
    const closing = await answerPracticeTurn(db, { sessionId: session.id, answerMd: ANSWER_MD });
    expect(closing.kind).toBe('closing');

    await evaluatePractice(db, { sessionId: session.id });
    await expect(
      answerPracticeTurn(db, { sessionId: session.id, answerMd: ANSWER_MD }),
    ).rejects.toThrow(/已结束/);
  });

  it('空作答不落库也不问模型', async () => {
    mockModel();
    const session = await startPracticeSession(db, {
      campaignId: CAMPAIGN_ID,
      formatId: FORMAT_ID,
    });
    const calls = vi.mocked(completeJsonWithSystem).mock.calls.length;

    await expect(
      answerPracticeTurn(db, { sessionId: session.id, answerMd: '   ' }),
    ).rejects.toThrow(/作答不能为空/);

    expect(vi.mocked(completeJsonWithSystem).mock.calls).toHaveLength(calls);
  });

  it('评分校验不过时不落库：引文对不上就重试一次，仍不过则报错', async () => {
    vi.mocked(completeJsonWithSystem).mockImplementation(async (_role, _system, user) => {
      if (user.includes('提交评分的作答')) {
        return {
          feedbackMd: 'x',
          improvedScriptMd: '',
          dimensions: RUBRIC.dimensions.map((dimension) => ({
            dimensionId: dimension.id,
            score: 5,
            answerQuote: '这句回答里根本没有',
            rationale: '编的引文',
          })),
        };
      }
      return { questionMd: QUESTION_MD };
    });

    const session = await startPracticeSession(db, {
      campaignId: CAMPAIGN_ID,
      formatId: FORMAT_ID,
    });
    await answerPracticeTurn(db, { sessionId: session.id, answerMd: ANSWER_MD });

    await expect(evaluatePractice(db, { sessionId: session.id })).rejects.toThrow(/没有落库/);
    expect(
      db.getFirstSync<{ n: number }>(`SELECT count(*) AS n FROM practice_attempt`)?.n,
    ).toBe(0);
  });
});
