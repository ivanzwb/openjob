/**
 * R1–R3 真实模型契约冒烟（方案 §6）。
 *
 * 前面所有用例都把 AI 路径打成了桩——那让「逻辑」确定，但也意味着 **prompt 与读回之间的约定
 * 漂移**（「模型返回的题目为空」那类）只能靠人去撞。这一组专门盯它：同一套仓储代码、真实的
 * provider，只断言「模型交回来的东西能被读回端认出来」。
 *
 * 三个门槛，任一不满足就整组自跳；钩子写在 describe 里面，跳了就不会白起一个实例：
 * 1. `E2E_LIVE=1`——它要真花钱、真联网、结果不确定，不该混进每次都要跑的那批；
 * 2. 本机要有真实的 provider 配置（`hasRealProvider()`）；
 * 3. 密钥不经过测试进程：把本机真实的 config / secrets / Local State 搬进隔离副本，
 *    应用自己解密（safeStorage 要的 OSCrypt 密钥就在 Local State 里）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { launchApp, type AppInstance } from '../harness/app';
import { AppDb } from '../harness/db';
import { hasRealProvider, makeEnv } from '../harness/env';
import { RESUME_TEXT, seedCampaign, setRoleProfile } from '../harness/seed';

const LIVE = process.env['E2E_LIVE'] === '1';

describe.skipIf(!LIVE || !hasRealProvider())('R1–R3 真实模型契约冒烟', () => {
  let app: AppInstance;
  let db: AppDb;
  let campaignId = '';
  let nodeId = '';

  beforeAll(async () => {
    const env = makeEnv('live', { useRealProvider: true });
    app = await launchApp({ userData: env.userData });
    db = AppDb.open(join(env.userData, 'openjob.db'));
    const seeded = await seedCampaign(app);
    campaignId = seeded.campaignId;
    await setRoleProfile(app, campaignId);
    const node = await app.page.invoke<{ id: string }>('node:create', {
      campaignId,
      parentId: null,
      name: 'R 冒烟考点：JVM 内存模型',
      kind: 'knowledge',
    });
    nodeId = node.id;
  }, 300_000);

  afterAll(async () => {
    db?.close();
    await app?.stop();
  });

  it('R1 出题读回：真实模型交回的题目能被读回端认出来', async () => {
    const session = await app.page.invoke<{ turns: Array<{ contentMd: string }> }>(
      'practice:createSession',
      { campaignId, examForm: 'selfIntro', language: 'zh' },
    );
    const question = session.turns.find((turn) => turn.contentMd)?.contentMd ?? '';
    // 空题目正是「模型返回的题目为空」那条 bug 的形态：这里要求它是真的一段话
    expect(question.trim().length).toBeGreaterThan(10);
  }, 300_000);

  it('R2 评分读回：四个维度齐全，且引文能在作答里定位', async () => {
    const session = await app.page.invoke<{ id: string }>('practice:createSession', {
      campaignId,
      examForm: 'selfIntro',
      language: 'zh',
    });
    const answer =
      '我是考核候选人，在软件研发领域做了十七年，最近十五年做设备管理平台的架构。' +
      '我主导过基站网元管理系统从 C/S 到 B/S 的架构演进，抽象出统一的后端接口。' +
      '贵司岗位要求的架构设计与性能优化，正是我这些年积累的地方。';
    await app.page.invoke('practice:nextTurn', { sessionId: session.id, answerMd: answer });
    const evaluation = await app.page.invoke<{
      scores: Array<{ dimensionId: string; score: number }>;
      totalScore: number;
    }>('practice:evaluate', { sessionId: session.id, answerMd: answer, language: 'zh' });

    expect(evaluation.scores).toHaveLength(4);
    expect(evaluation.scores.every((s) => s.score >= 1 && s.score <= 5)).toBe(true);
    // 引文对不上时读回端会整条打回并报 ungrounded-score；能走到这里说明四条都对上了
    expect(evaluation.totalScore).toBeGreaterThan(0);
  }, 300_000);

  it('R3 讲解与结构化：markdown 与 sections 都能读回', async () => {
    const explanation = await app.page.invoke<{ contentMd: string }>('explain:generate', {
      nodeId,
      tier: 'spoken',
    });
    expect(explanation.contentMd.trim().length).toBeGreaterThan(20);

    const structured = await app.page.invoke<{ contentMd: string }>('resume:aiStructure', {
      contentMd: RESUME_TEXT,
    });
    expect(structured.contentMd.trim().length).toBeGreaterThan(20);
  }, 300_000);
});
