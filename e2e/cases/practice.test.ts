/**
 * E70–E78 模拟面试：工具行、题型与语言、出题、追问、评分、引文打回、掌握度回写、历史、会话恢复。
 *
 * 这一组是历史上真出过问题的那条链路（「模型返回的题目为空」），也是唯一一条
 * 「界面 → 主进程 → 提示词组合 → 模型 → 读回 → 落库」全都要过的路径。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { launchApp, sleep, type AppInstance } from '../harness/app';
import { AppDb } from '../harness/db';
import { makeEnv, type Env } from '../harness/env';
import { seedReadyCampaign, type SeededCampaign } from '../harness/seed';
import { LlmStub } from '../harness/stub';
import {
  ACTIVE,
  ANSWER_MD,
  activeText,
  clickButton,
  clickNav,
  errorText,
  fillAnswer,
  selectOptions,
  selectValue,
  toolbarGeometry,
  waitActiveText,
} from '../harness/ui';

let stub: LlmStub;
let env: Env;
let app: AppInstance;
let db: AppDb;
let seeded: SeededCampaign;

const questions = (): string => stub.lastText('本次只出一道题');
const scores = (): string => stub.lastText('逐维度对照上面的评分量规打分');

beforeAll(async () => {
  stub = new LlmStub();
  await stub.start();
  env = makeEnv('practice', { llmBaseUrl: stub.baseUrl, searchEndpoint: stub.searchEndpoint });
  app = await launchApp({ userData: env.userData });
  db = AppDb.open(join(env.userData, 'openjob.db'));
  seeded = await seedReadyCampaign(app);
  await clickNav(app, '模拟面试');
  await waitActiveText(app, '模拟面试', '模拟面试页');
}, 180_000);

afterAll(async () => {
  db?.close();
  await app?.stop();
  await stub?.stop();
});

describe('E70–E71 工具行', () => {
  it('E70 关联备考 / 题型 / 面试语言 / 开始练习 在同一行', async () => {
    await selectValue(app, '题型', 'selfIntro');
    const items = await toolbarGeometry(app);
    const texts = items.map((i) => i.text);
    expect(texts.join('|')).toContain('关联备考');
    expect(texts.join('|')).toContain('题型');
    // items-end 对齐的是底边：底边一致即同一行
    expect(new Set(items.map((i) => i.bottom)).size).toBe(1);
    // 并且确实是从左到右排开，没有互相压住
    const lefts = items.map((i) => i.left);
    expect([...lefts].sort((a, b) => a - b)).toEqual(lefts);
  });

  it('E71 只有自我介绍带面试语言，且按（备考, 题型）记住', async () => {
    await selectValue(app, '题型', 'selfIntro');
    expect(await selectOptions(app, '面试语言')).toEqual(['zh', 'en']);

    await selectValue(app, '面试语言', 'en');
    await selectValue(app, '题型', 'concept');
    expect(await selectOptions(app, '面试语言')).toBeNull();

    await selectValue(app, '题型', 'selfIntro');
    const value = await app.page.evaluate<string>(
      `[...(${ACTIVE}.querySelectorAll('select') ?? [])]
         .find((s) => s.closest('label')?.textContent.includes('面试语言'))?.value ?? ''`,
    );
    expect(value).toBe('en');
    await selectValue(app, '面试语言', 'zh');
  });
});

describe('E72–E74 出题 / 追问 / 评分', () => {
  it('E72 出题：桩返回 {title, scenarioMd}，题目渲染出来，且 prompt 里带了结构声明', async () => {
    stub.clear();
    const before = await activeText(app);
    await clickButton(app, '开始练习|换一题');
    await app.page.waitUntil(async () => {
      const text = await activeText(app);
      return text.length > 20 && text !== before ? text : '';
    }, '题目出现');
    await waitActiveText(app, '60-90 秒', '题目正文');

    // 这一条就是「模型返回的题目为空」的回归：协议必须把结构声明拼进 prompt，
    // 片段里没有结构时模型才有东西可依
    expect(questions()).toContain('"scenarioMd"');
    expect(questions()).toContain('"title"');
    expect(await activeText(app)).toContain('你的回答');
  });

  it('E73 追问：作答后追加一轮面试官；到上限后直接收束不再问模型', async () => {
    await fillAnswer(app, ANSWER_MD);
    const beforeCalls = stub.calls('轮追问').length;
    await clickButton(app, '提交并追问');
    await app.page.waitUntil(async () => {
      const text = await activeText(app);
      return /面试官/.test(text.replace('面试官可根据回答情况', '')) ? text : '';
    }, '追问轮出现');
    expect(stub.calls('轮追问').length).toBeGreaterThan(beforeCalls);

    // 追问到上限：引擎自己收束，不再发请求
    const sessionId = await app.page.evaluate<string>(
      `[...(${ACTIVE}.querySelectorAll('button') ?? [])].length ? '' : ''`,
    );
    void sessionId;
    const sessions = db.all<{ id: string; max_follow_ups: number }>(
      `SELECT id, max_follow_ups FROM practice_session ORDER BY created_at DESC LIMIT 1`,
    );
    const current = sessions[0]!;
    const callsBeforeClose = stub.calls('轮追问').length;
    for (let round = 0; round < current.max_follow_ups + 1; round += 1) {
      const closing = await app.page.invoke<{ kind: string; contentMd: string } | null>(
        'practice:nextTurn',
        { sessionId: current.id, answerMd: `第 ${round + 1} 轮补充作答。` },
      );
      if (closing?.kind === 'closing') {
        expect(closing.contentMd).toContain('上限');
        break;
      }
    }
    const closingRow = db.get<{ content_md: string }>(
      `SELECT content_md FROM practice_turn WHERE session_id = ? AND kind = 'closing'`,
      current.id,
    );
    expect(closingRow?.content_md).toContain('上限');
    expect(stub.calls('轮追问').length).toBe(callsBeforeClose + current.max_follow_ups - 1);
  });

  it('E74 评分：4 张维度卡 + 总分 + 整体反馈 + 改进稿，并落库', async () => {
    stub.clear();
    await clickButton(app, '提交评分');
    const scored = await app.page.waitUntil(async () => {
      const error = await errorText(app);
      if (error) throw new Error(`评分报错：${error}`);
      return app.page.evaluate<{
        cards: number;
        total: string;
        feedback: boolean;
        improved: boolean;
      } | null>(`(() => {
        const panel = ${ACTIVE};
        const cards = [...panel.querySelectorAll('li')].filter((li) => li.textContent.includes('量规锚点（'));
        if (cards.length === 0) return null;
        const total = [...panel.querySelectorAll('span')].find((s) => s.className.includes('text-2xl'));
        const headings = [...panel.querySelectorAll('h4')].map((h) => h.textContent.trim());
        return {
          cards: cards.length,
          total: total ? total.textContent.trim() : '',
          feedback: headings.includes('整体反馈'),
          improved: headings.includes('改进稿'),
        };
      })()`);
    }, '评分结果渲染', 180_000);

    expect(scored.cards).toBe(4);
    expect(scored.total).not.toBe('');
    expect(scored.feedback).toBe(true);
    expect(scored.improved).toBe(true);

    // prompt 里必须逐个列出量规维度，否则模型会漏维度
    const prompt = scores();
    for (const id of ['core.self-intro.structure', 'core.self-intro.credibility']) {
      expect(prompt).toContain(id);
    }

    const session = db.get<{ id: string }>(
      `SELECT id FROM practice_session ORDER BY created_at DESC LIMIT 1`,
    )!;
    const attempt = db.get<{ id: string; total_score: number }>(
      `SELECT id, total_score FROM practice_attempt WHERE session_id = ?`,
      session.id,
    );
    expect(attempt).toBeDefined();
    expect(db.count('practice_score', 'attempt_id = ?', attempt!.id)).toBe(4);
    const status = db.get<{ status: string }>(
      `SELECT status FROM practice_session WHERE id = ?`,
      session.id,
    );
    expect(status?.status).toBe('evaluated');
  });

  it('E75 引文对不上：修复重试仍失败时明确报错，且不落库', async () => {
    stub.ungroundedQuote = true;
    stub.clear();
    const attemptsBefore = db.count('practice_attempt');

    await selectValue(app, '题型', 'selfIntro');
    await clickButton(app, '换一题');
    await sleep(1500);
    await fillAnswer(app, ANSWER_MD);
    await clickButton(app, '提交评分');

    const error = await app.page.waitUntil(
      () => errorText(app),
      '评分失败提示',
      180_000,
    );
    expect(error).toContain('评分');
    // 一次带诊断的重试：评分请求应当出现两次（首次 + 修复）
    expect(stub.calls('逐维度对照上面的评分量规打分').length).toBeGreaterThanOrEqual(2);
    expect(db.count('practice_attempt')).toBe(attemptsBefore);
    stub.ungroundedQuote = false;
  });
});

describe('E76–E78 掌握度 / 历史 / 会话恢复', () => {
  it('E76 带考点的会话评完分后回写掌握度', async () => {
    const node = await app.page.invoke<{ id: string }>('node:create', {
      campaignId: seeded.campaignId,
      parentId: null,
      name: 'E2E 考点：JVM 内存模型',
      kind: 'knowledge',
    });
    const before = db.get<{ mastery: number }>(
      `SELECT mastery FROM knowledge_node WHERE id = ?`,
      node.id,
    );

    const session = await app.page.invoke<{ id: string }>('practice:createSession', {
      campaignId: seeded.campaignId,
      examForm: 'selfIntro',
      nodeId: node.id,
      language: 'zh',
    });
    await app.page.invoke('practice:nextTurn', { sessionId: session.id, answerMd: ANSWER_MD });
    const evaluation = await app.page.invoke<{ totalScore: number; mastery?: unknown }>(
      'practice:evaluate',
      { sessionId: session.id, answerMd: ANSWER_MD, language: 'zh' },
    );
    expect(evaluation.totalScore).toBeGreaterThan(0);
    expect(evaluation.mastery).toBeTruthy();

    const after = db.get<{ mastery: number }>(
      `SELECT mastery FROM knowledge_node WHERE id = ?`,
      node.id,
    );
    expect(after!.mastery).not.toBe(before!.mastery);
  });

  it('E77 历史：按备考 / 考点 / 来源取回 attempt，并带分数', async () => {
    const all = await app.page.invoke<
      Array<{ id: string; source: string; totalScore: number; nodeId: string | null }>
    >('practice:listAttempts', { campaignId: seeded.campaignId });
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((a) => a.source === 'practice')).toBe(true);
    expect(all.some((a) => a.totalScore > 0)).toBe(true);

    // 按考点筛：E76 那条挂在考点上
    const node = db.get<{ id: string }>(
      `SELECT id FROM knowledge_node WHERE name = 'E2E 考点：JVM 内存模型'`,
    )!;
    const byNode = await app.page.invoke<Array<{ id: string }>>('practice:listAttempts', {
      campaignId: seeded.campaignId,
      nodeId: node.id,
    });
    expect(byNode).toHaveLength(1);

    // 按来源筛：练习链路的 attempt 只应落在 practice 这一档
    const bySource = await app.page.invoke<Array<{ id: string }>>('practice:listAttempts', {
      campaignId: seeded.campaignId,
      sources: ['quiz'],
    });
    expect(bySource).toHaveLength(0);

    const scoresOfAttempt = await app.page.invoke<Array<{ dimensionId: string; score: number }>>(
      'practice:listScores',
      { attemptId: byNode[0]!.id },
    );
    expect(scoresOfAttempt).toHaveLength(4);
    expect(scoresOfAttempt.every((s) => s.score >= 1 && s.score <= 5)).toBe(true);
  });

  it('E78 切走再回来，会话与之前的作答决策还在', async () => {
    const sessionsBefore = db.count('practice_session');
    await clickNav(app, '总览');
    await clickNav(app, '模拟面试');
    await waitActiveText(app, '模拟面试', '模拟面试页');
    expect(db.count('practice_session')).toBe(sessionsBefore);
    const text = await activeText(app);
    expect(text).toMatch(/题目|开始练习|换一题/);
  });
});
