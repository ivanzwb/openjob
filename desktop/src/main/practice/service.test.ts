/**
 * PracticeProtocol 的端到端用例：真迁移建库、真运行时描述符、真组合器，只有模型
 * 是替身。
 *
 * 三条验收在这里过库：每个分数能关联 Rubric anchor 与用户原回答、评分不合格时
 * 一行都不落、绑定考点的会话把掌握度回写到唯一那条路径上。
 */

import type { Database } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { PracticeError } from '@core/practice';
import { softwareEngineeringRolePack } from '@plugins/softwareEngineering';
import type { ComposedPrompt } from '@core/prompts/composer';
import {
  ANSWER_MD,
  CAMPAIGN_ID,
  KNOWLEDGE_FORMAT_ID,
  NODE_ID,
  newPracticeDb,
  nodeRow,
} from './__fixtures__/campaign';
import { createPracticeService, type PracticeService } from './service';

const RUBRIC_ID = 'se.technical-knowledge-rubric';

/** 三段都逐字取自 ANSWER_MD，所以引文能定位 */
const QUOTES = {
  'technical-accuracy': '消费端先按消息 ID 查去重表，命中就直接 ack',
  depth: '写入去重表和业务\n落库放在同一个本地事务里',
  tradeoffs: '位点提交改成手动，业务事务提交成功之后才提交位点。',
};

interface Call {
  slot: string;
  user: string;
  prompt: ComposedPrompt;
}

interface Harness {
  raw: Database;
  service: PracticeService;
  calls: Call[];
}

function evaluation(
  scores: Partial<Record<keyof typeof QUOTES, number>>,
  quotes: Partial<Record<keyof typeof QUOTES, string>> = {},
): unknown {
  return {
    feedbackMd: '幂等这块讲清楚了，位点与事务的顺序还可以再说一层。',
    improvedScriptMd: '先说去重表，再说事务边界。',
    dimensions: (Object.keys(QUOTES) as Array<keyof typeof QUOTES>)
      .filter((id) => scores[id] !== undefined)
      .map((id) => ({
        dimensionId: id,
        score: scores[id],
        answerQuote: quotes[id] ?? QUOTES[id],
        rationale: `${id} 的理由`,
      })),
  };
}

/**
 * 模型替身：按 slot 取下一个预置回复。
 *
 * 每个 slot 一个队列而不是一个固定值：评分要能第一次给坏结果、第二次给好结果，
 * 才测得到「校验不过重问一次」那条路径。
 */
function harness(options: {
  questions?: unknown[];
  evaluations?: unknown[];
  nodeId?: string | null;
  mastery?: number;
  masterySource?: 'self' | 'quiz' | 'mixed';
}): Harness {
  const raw = newPracticeDb({
    mastery: options.mastery ?? 2,
    masterySource: options.masterySource ?? 'self',
  });
  const calls: Call[] = [];
  const queues: Record<string, unknown[]> = {
    questionGeneration: [...(options.questions ?? [{ question: '说说你怎么保证消费幂等' }])],
    scoring: [...(options.evaluations ?? [])],
  };

  let seq = 0;
  const service = createPracticeService({
    raw,
    now: () => 1_700_000_000_000 + seq,
    newId: () => `id-${++seq}`,
    completeJson: async <T>(request: {
      prompt: ComposedPrompt;
      user: string;
    }): Promise<T> => {
      const slot = request.prompt.provenance.promptSlot;
      calls.push({ slot, user: request.user, prompt: request.prompt });
      const next = queues[slot]?.shift();
      if (next === undefined) throw new Error(`预置回复用尽：${slot}`);
      return next as T;
    },
  });

  return { raw, service, calls };
}

function count(raw: Database, table: string, where = '1=1'): number {
  return (raw.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number })
    .n;
}

async function rejectionCode(task: Promise<unknown>): Promise<string> {
  try {
    await task;
  } catch (error) {
    if (error instanceof PracticeError) return error.code;
    throw error;
  }
  throw new Error('这次调用本该失败');
}

async function openSession(h: Harness, nodeId: string | null = NODE_ID): Promise<string> {
  const session = await h.service.createSession({
    campaignId: CAMPAIGN_ID,
    nodeId,
    formatId: KNOWLEDGE_FORMAT_ID,
  });
  return session.id;
}

describe('createSession', () => {
  it('落一份会话与首题，并快照当时的岗位包版本与配置哈希', async () => {
    const h = harness({});

    const session = await h.service.createSession({
      campaignId: CAMPAIGN_ID,
      nodeId: NODE_ID,
      formatId: KNOWLEDGE_FORMAT_ID,
    });

    expect(session).toMatchObject({
      campaignId: CAMPAIGN_ID,
      nodeId: NODE_ID,
      formatId: KNOWLEDGE_FORMAT_ID,
      protocol: 'knowledge',
      rubricId: RUBRIC_ID,
      rolePackId: softwareEngineeringRolePack.manifest.id,
      rolePackVersion: softwareEngineeringRolePack.manifest.version,
      status: 'open',
      // 岗位包声明的追问上限，不是引擎写死的常量
      maxFollowUps: 3,
      followUpStrategy: 'adaptive',
    });
    expect(session.configSnapshotHash).toMatch(/^[a-f0-9]{64}$/);

    expect(session.turns).toHaveLength(1);
    expect(session.turns[0]).toMatchObject({
      index: 0,
      speaker: 'interviewer',
      kind: 'question',
      contentMd: '说说你怎么保证消费幂等',
    });
  });

  it('System Prompt 走组合器，provenance 记住题型与量规', async () => {
    const h = harness({});

    await openSession(h);

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].prompt.provenance).toMatchObject({
      promptSlot: 'questionGeneration',
      formatId: KNOWLEDGE_FORMAT_ID,
      rubricId: RUBRIC_ID,
      rolePack: {
        id: softwareEngineeringRolePack.manifest.id,
        version: softwareEngineeringRolePack.manifest.version,
      },
    });
  });

  it('既没给 formatId 也没给旧题型时报 unknown-format', async () => {
    const h = harness({});

    await expect(h.service.createSession({ campaignId: CAMPAIGN_ID })).rejects.toThrow(
      PracticeError,
    );
  });

  it('旧的 ExamForm 能换成题型 ID，保证旧调用点不用先改数据', async () => {
    const h = harness({});

    const session = await h.service.createSession({
      campaignId: CAMPAIGN_ID,
      legacyExamForm: 'concept',
    });

    expect(session.formatId).toBe(KNOWLEDGE_FORMAT_ID);
  });
});

describe('nextTurn', () => {
  it('先落作答再追问：模型这一步失败时用户敲的字不跟着丢', async () => {
    const h = harness({
      questions: [{ question: '首题' }],
      // 追问没有预置回复，替身会抛错
    });
    const sessionId = await openSession(h);

    await expect(h.service.nextTurn({ sessionId, answerMd: '我的回答' })).rejects.toThrow(
      '预置回复用尽',
    );

    const turns = h.service.getSession(sessionId)?.turns ?? [];
    expect(turns.map((turn) => turn.kind)).toEqual(['question', 'answer']);
    expect(turns[1].contentMd).toBe('我的回答');
  });

  it('追问轮次递增，序号连续', async () => {
    const h = harness({
      questions: [{ question: '首题' }, { question: '追问一' }, { question: '追问二' }],
    });
    const sessionId = await openSession(h);

    await h.service.nextTurn({ sessionId, answerMd: '答一' });
    await h.service.nextTurn({ sessionId, answerMd: '答二' });

    const turns = h.service.getSession(sessionId)?.turns ?? [];
    expect(turns.map((turn) => turn.index)).toEqual([0, 1, 2, 3, 4]);
    expect(turns.map((turn) => turn.kind)).toEqual([
      'question',
      'answer',
      'followUp',
      'answer',
      'followUp',
    ]);
  });

  /** 上限由岗位包定，越界之后由引擎收束，不再多花一次模型调用 */
  it('追问到上限后给收束语，且不再问模型', async () => {
    const h = harness({
      questions: [
        { question: '首题' },
        { question: '追问一' },
        { question: '追问二' },
        { question: '追问三' },
      ],
    });
    const sessionId = await openSession(h);

    for (const answer of ['答一', '答二', '答三']) {
      await h.service.nextTurn({ sessionId, answerMd: answer });
    }
    const callsBefore = h.calls.length;

    const closing = await h.service.nextTurn({ sessionId, answerMd: '答四' });

    expect(closing.kind).toBe('closing');
    expect(h.calls).toHaveLength(callsBefore);
  });

  it('空作答与已结束的会话都拒掉', async () => {
    const h = harness({ questions: [{ question: '首题' }] });
    const sessionId = await openSession(h);

    await expect(h.service.nextTurn({ sessionId, answerMd: '   ' })).rejects.toThrow(
      PracticeError,
    );
    expect(count(h.raw, 'practice_turn')).toBe(1);

    h.raw.prepare(`UPDATE practice_session SET status = 'evaluated' WHERE id = ?`).run(sessionId);
    await expect(h.service.nextTurn({ sessionId, answerMd: '还想答' })).rejects.toThrow(
      PracticeError,
    );
  });
});

describe('evaluate', () => {
  it('逐维度落库，每个分数都带 rubric 锚点原文与原回答里的逐字引用', async () => {
    const h = harness({
      evaluations: [evaluation({ 'technical-accuracy': 4, depth: 3, tradeoffs: 4 })],
    });
    const sessionId = await openSession(h);

    const result = await h.service.evaluate({ sessionId, answerMd: ANSWER_MD });

    // 4*0.5 + 3*0.3 + 4*0.2
    expect(result.totalScore).toBeCloseTo(3.7, 5);
    expect(result.scores).toHaveLength(3);

    const rows = h.raw
      .prepare(
        `SELECT dimension_id, dimension_label, weight, critical, score,
                anchor_md, answer_quote, answer_start, answer_end, rationale_md
         FROM practice_score WHERE attempt_id = ? ORDER BY dimension_id`,
      )
      .all(result.attemptId) as Array<Record<string, string | number>>;

    expect(rows.map((row) => row.dimension_id)).toEqual([
      'depth',
      'technical-accuracy',
      'tradeoffs',
    ]);

    const accuracy = rows.find((row) => row.dimension_id === 'technical-accuracy')!;
    expect(accuracy).toMatchObject({
      dimension_label: '技术准确性',
      weight: 0.5,
      critical: 1,
      score: 4,
      // 岗位包里 4 分那一档的原文，不是模型自己写的评语
      anchor_md: '准确解释机制、边界和常见陷阱',
    });
    expect(accuracy.rationale_md).toBe('technical-accuracy 的理由');
  });

  /**
   * 区间必须能把原文切回来。
   *
   * 只存引文字符串的话，模型把原话改一个字也照样存得下；存区间并要求切片相等，
   * 「这句话是候选人说的」才是可复核的。
   */
  it('存下来的区间能在原回答上逐字切回同一段', async () => {
    const h = harness({
      evaluations: [evaluation({ 'technical-accuracy': 4, depth: 3, tradeoffs: 4 })],
    });
    const sessionId = await openSession(h);

    const result = await h.service.evaluate({ sessionId, answerMd: ANSWER_MD });

    const rows = h.raw
      .prepare(
        `SELECT s.answer_quote, s.answer_start, s.answer_end, a.answer_md
         FROM practice_score s JOIN practice_attempt a ON a.id = s.attempt_id
         WHERE s.attempt_id = ?`,
      )
      .all(result.attemptId) as Array<{
      answer_quote: string;
      answer_start: number;
      answer_end: number;
      answer_md: string;
    }>;

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.answer_md.slice(row.answer_start, row.answer_end)).toBe(row.answer_quote);
      expect(ANSWER_MD).toContain(row.answer_quote);
    }
  });

  it('绑定考点的会话把掌握度写到唯一那条路径上，status 与 priority 一起动', async () => {
    const h = harness({
      mastery: 2,
      masterySource: 'self',
      evaluations: [evaluation({ 'technical-accuracy': 4, depth: 3, tradeoffs: 4 })],
    });
    const sessionId = await openSession(h);

    const result = await h.service.evaluate({ sessionId, answerMd: ANSWER_MD });

    // 首次客观分与先验各半：(2 + 3.7) / 2
    expect(result.mastery?.mastery).toBeCloseTo(2.85, 5);
    expect(nodeRow(h.raw)).toMatchObject({ mastery_source: 'quiz', status: 'learning' });
    expect(nodeRow(h.raw).priority_score).toBeCloseTo(result.mastery!.priorityScore, 10);
  });

  it('通用练习没绑考点时不回写掌握度', async () => {
    const h = harness({
      evaluations: [evaluation({ 'technical-accuracy': 5, depth: 5, tradeoffs: 5 })],
    });
    const sessionId = await openSession(h, null);
    const before = nodeRow(h.raw);

    const result = await h.service.evaluate({ sessionId, answerMd: ANSWER_MD });

    expect(result.mastery).toBeNull();
    expect(nodeRow(h.raw)).toEqual(before);
  });

  it('评完把会话标成 evaluated，attempt 记下用的是哪个版本的 prompt', async () => {
    const h = harness({
      evaluations: [evaluation({ 'technical-accuracy': 4, depth: 3, tradeoffs: 4 })],
    });
    const sessionId = await openSession(h);

    const result = await h.service.evaluate({ sessionId, answerMd: ANSWER_MD });

    expect(h.service.getSession(sessionId)?.status).toBe('evaluated');
    const attempt = h.raw
      .prepare(`SELECT prompt_version_id, needs_repractice FROM practice_attempt WHERE id = ?`)
      .get(result.attemptId) as { prompt_version_id: string; needs_repractice: number };
    expect(attempt.prompt_version_id).toBe(
      h.calls.at(-1)!.prompt.provenance.promptVersionId,
    );
    expect(attempt.needs_repractice).toBe(0);
  });

  it('总分低于通过阈值时标记需要复练', async () => {
    const h = harness({
      evaluations: [evaluation({ 'technical-accuracy': 2, depth: 2, tradeoffs: 3 })],
    });
    const sessionId = await openSession(h);

    const result = await h.service.evaluate({ sessionId, answerMd: ANSWER_MD });

    expect(result.needsRePractice).toBe(true);
  });

  it('关键维度触到 1 分就要复练，哪怕总分不低', async () => {
    const h = harness({
      evaluations: [evaluation({ 'technical-accuracy': 1, depth: 5, tradeoffs: 5 })],
    });
    const sessionId = await openSession(h);

    const result = await h.service.evaluate({ sessionId, answerMd: ANSWER_MD });

    expect(result.totalScore).toBeCloseTo(3, 5);
    expect(result.needsRePractice).toBe(true);
  });

  it('引文对不上时带诊断重问一次，补上了就照常落库', async () => {
    const h = harness({
      evaluations: [
        // 第一次把原话改了一个词，定位不到
        evaluation(
          { 'technical-accuracy': 4, depth: 3, tradeoffs: 4 },
          { 'technical-accuracy': '消费端先按订单 ID 查去重表' },
        ),
        evaluation({ 'technical-accuracy': 4, depth: 3, tradeoffs: 4 }),
      ],
    });
    const sessionId = await openSession(h);

    const result = await h.service.evaluate({ sessionId, answerMd: ANSWER_MD });

    const scoringCalls = h.calls.filter((call) => call.slot === 'scoring');
    expect(scoringCalls).toHaveLength(2);
    // 重问时要说清是哪一维、哪一条对不上，否则模型只会再猜一遍
    expect(scoringCalls[1].user).toContain('technical-accuracy');
    expect(result.scores).toHaveLength(3);
  });

  /**
   * fail closed。
   *
   * 放行一个引文对不上的分数只是少一句原文，但这个数字会改写掌握度，而掌握度是
   * 复练、优先级和当天计划的输入——错一次之后没人能顺着链条找回来。
   */
  it('补一次仍然对不上就整次拒掉，一行都不落，掌握度不动', async () => {
    const bad = evaluation(
      { 'technical-accuracy': 4, depth: 3, tradeoffs: 4 },
      { 'technical-accuracy': '这句话候选人根本没说过' },
    );
    const h = harness({ evaluations: [bad, bad] });
    const sessionId = await openSession(h);
    const before = nodeRow(h.raw);

    expect(await rejectionCode(h.service.evaluate({ sessionId, answerMd: ANSWER_MD }))).toBe(
      'ungrounded-score',
    );

    expect(count(h.raw, 'practice_attempt')).toBe(0);
    expect(count(h.raw, 'practice_score')).toBe(0);
    expect(nodeRow(h.raw)).toEqual(before);
    // 会话仍然开着：用户可以重新提交，而不是被一次评分失败锁死
    expect(h.service.getSession(sessionId)?.status).toBe('open');
  });

  it('少给一个维度同样拒掉，错误码指向缺维而不是引文', async () => {
    const partial = evaluation({ 'technical-accuracy': 4, depth: 3 });
    const h = harness({ evaluations: [partial, partial] });
    const sessionId = await openSession(h);

    expect(await rejectionCode(h.service.evaluate({ sessionId, answerMd: ANSWER_MD }))).toBe(
      'missing-dimension',
    );
    expect(count(h.raw, 'practice_attempt')).toBe(0);
  });

  it('没传作答时取最后一轮候选人发言', async () => {
    const h = harness({
      questions: [{ question: '首题' }, { question: '追问一' }],
      evaluations: [evaluation({ 'technical-accuracy': 4, depth: 3, tradeoffs: 4 })],
    });
    const sessionId = await openSession(h);
    await h.service.nextTurn({ sessionId, answerMd: ANSWER_MD });

    const result = await h.service.evaluate({ sessionId });

    const attempt = h.raw
      .prepare(`SELECT answer_md, transcript_md FROM practice_attempt WHERE id = ?`)
      .get(result.attemptId) as { answer_md: string; transcript_md: string };
    expect(attempt.answer_md).toBe(ANSWER_MD);
    // 追问过程也要留档，否则复核时看不出这个分是在第几轮给的
    expect(attempt.transcript_md).toContain('追问一');
  });

  it('一句作答都没有时拒评，不给一个凭空的 0 分', async () => {
    const h = harness({ evaluations: [evaluation({})] });
    const sessionId = await openSession(h);

    await expect(h.service.evaluate({ sessionId })).rejects.toThrow(PracticeError);
    expect(count(h.raw, 'practice_attempt')).toBe(0);
  });
});
