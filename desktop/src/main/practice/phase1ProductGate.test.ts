/**
 * Phase 1 闸门的桌面半场：产品战役真的能练、能评、评不出来就不落库。
 *
 * 共享层的 phase1Gate 证明的是「声明与组合是对的」，但那一层没有库。一个岗位包
 * 完全可能组合得出漂亮的 Prompt，却在真实练习路径上取不到量规、写不进 attempt，
 * 或者评分校验不过时留下半条记录。所以这里走 createPracticeService 的真路径：
 * 真迁移建库、真运行时描述符、真组合器，只有模型是替身。
 *
 * 用例刻意与 service.test.ts 的工程用例结构对照：同一条控制流换一个岗位包，
 * 落库形状必须只在「岗位包声明的那部分」不同。
 */

import type { Database } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { PracticeError } from '@core/practice';
import {
  PRODUCT_MANAGER_FORMAT_IDS,
  PRODUCT_MANAGER_ROLE_PACK_ID,
  productManagerRolePack,
} from '@plugins/productManager';
import {
  PHASE1_CAMPAIGN,
  PHASE1_ENGINEERING_MARKERS,
  PHASE1_NODES,
} from '@core/plugins/__fixtures__/phase1Campaign';
import type { ComposedPrompt } from '@core/prompts/composer';
import { newLegacyDb } from '../db/__fixtures__/legacyDb';
import { installRolePacks } from '../plugins/__fixtures__/installedPlugins';
import { setCampaignRoleProfile } from '../plugins/runtime';
import { createPracticeService, type PracticeService } from './service';

const CASE_FORMAT_ID = PRODUCT_MANAGER_FORMAT_IDS.productCase;
const CASE_RUBRIC_ID = 'pm.product-case-rubric';
const NODE_ID = 'phase1-node-metrics';

/** 候选人作答原文。评分引文必须能逐字定位到这段里，否则不许落库。 */
const ANSWER_MD = `先界定问题：要解决的是新注册用户在第 7 天大量流失，目标人群是首次下单前的新用户，
成败看第 14 天的留存率。

从调研看流失集中在两类人：一类没找到合适的车型，一类被首单价格劝退。访谈 20 人里
有 13 人主动提到价格不透明。

方案上我先做首单价格预估，再做车型推荐。预估投入更小而且直接对着价格顾虑，推荐
放到下个迭代。

衡量上主指标是第 14 天留存，护栏指标是客单价与取消率，先用实验跑两周再决定全量。`;

/** 四段都逐字取自 ANSWER_MD，所以引文能定位。 */
const QUOTES = {
  'problem-definition': '目标人群是首次下单前的新用户',
  'user-and-market-insight': '访谈 20 人里\n有 13 人主动提到价格不透明',
  'solution-and-prioritization': '预估投入更小而且直接对着价格顾虑',
  'success-metrics': '主指标是第 14 天留存，护栏指标是客单价与取消率',
};

type DimensionId = keyof typeof QUOTES;

interface Call {
  slot: string;
  prompt: ComposedPrompt;
}

interface Harness {
  raw: Database;
  service: PracticeService;
  calls: Call[];
}

/**
 * 产品战役建库。
 *
 * descriptor 走 setCampaignRoleProfile 而不是手写一行 binding：出题与评分都要求
 * 组合器里的岗位包版本与 descriptor 逐字一致，手写的假绑定过不了那一关。
 */
function newProductPracticeDb(): Database {
  // 岗位包由用户安装，绑定之前先装上
  installRolePacks();
  const raw = newLegacyDb();

  raw
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

  const insertNode = raw.prepare(
    `INSERT INTO knowledge_node (
       id, campaign_id, parent_id, name, kind, coverage_type, exam_prob, difficulty,
       est_minutes, exam_forms, mastery, mastery_source, priority_score, status, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 0.8, ?, ?, ?, 2, 'self', ?, 'learning', 1)`,
  );
  for (const node of PHASE1_NODES) {
    insertNode.run(
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

  setCampaignRoleProfile(
    raw,
    {
      campaignId: PHASE1_CAMPAIGN.id,
      roleFamily: 'product',
      rolePackId: PRODUCT_MANAGER_ROLE_PACK_ID,
    },
    { now: () => 1000 },
  );

  return raw;
}

function evaluation(
  scores: Partial<Record<DimensionId, number>>,
  quotes: Partial<Record<DimensionId, string>> = {},
): unknown {
  return {
    feedbackMd: '问题定义和指标都说清楚了，优先级的代价还可以再讲一层。',
    improvedScriptMd: '先给结论，再讲放弃了什么。',
    dimensions: (Object.keys(QUOTES) as DimensionId[])
      .filter((id) => scores[id] !== undefined)
      .map((id) => ({
        dimensionId: id,
        score: scores[id],
        answerQuote: quotes[id] ?? QUOTES[id],
        rationale: `${id} 的理由`,
      })),
  };
}

/** 模型替身：每个 slot 一个队列，才测得到「校验不过重问一次」那条路径。 */
function harness(options: { questions?: unknown[]; evaluations?: unknown[] } = {}): Harness {
  const raw = newProductPracticeDb();
  const calls: Call[] = [];
  // 首题之外再备一条追问：产品案例允许 3 轮追问，nextTurn 会再问一次模型
  const queues: Record<string, unknown[]> = {
    questionGeneration: [
      ...(options.questions ?? [
        { question: '新用户第 7 天流失明显，你会怎么定位和解决？' },
        { question: '如果价格预估上线后留存没动，你下一步看什么？' },
      ]),
    ],
    scoring: [...(options.evaluations ?? [])],
  };

  let seq = 0;
  const service = createPracticeService({
    raw,
    now: () => 1_700_000_000_000 + seq,
    newId: () => `id-${++seq}`,
    completeJson: async <T>(request: { prompt: ComposedPrompt }): Promise<T> => {
      const slot = request.prompt.provenance.promptSlot;
      calls.push({ slot, prompt: request.prompt });
      const next = queues[slot]?.shift();
      if (next === undefined) throw new Error(`预置回复用尽：${slot}`);
      return next as T;
    },
  });

  return { raw, service, calls };
}

function count(raw: Database, table: string): number {
  return (raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
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

async function openCase(h: Harness): Promise<string> {
  const session = await h.service.createSession({
    campaignId: PHASE1_CAMPAIGN.id,
    nodeId: NODE_ID,
    formatId: CASE_FORMAT_ID,
  });
  return session.id;
}

describe('Phase 1 产品战役练习闸门', () => {
  it('产品案例会话快照的是产品岗位包的题型、量规与版本', async () => {
    const h = harness();

    const session = await h.service.createSession({
      campaignId: PHASE1_CAMPAIGN.id,
      nodeId: NODE_ID,
      formatId: CASE_FORMAT_ID,
    });

    expect(session).toMatchObject({
      campaignId: PHASE1_CAMPAIGN.id,
      nodeId: NODE_ID,
      formatId: CASE_FORMAT_ID,
      protocol: 'case',
      rubricId: CASE_RUBRIC_ID,
      rolePackId: PRODUCT_MANAGER_ROLE_PACK_ID,
      rolePackVersion: productManagerRolePack.manifest.version,
      maxFollowUps: 3,
    });
    expect(count(h.raw, 'practice_session')).toBe(1);
  });

  it('出题走的是产品岗位包自己的片段，没有引用 Core 的工程 Prompt', async () => {
    const h = harness();
    await openCase(h);

    const question = h.calls.find((call) => call.slot === 'questionGeneration');
    expect(question).toBeDefined();
    // 自带片段的 promptId 形如 <packId>#<slot>:<formatId>；registry key 不是这个形状
    expect(question?.prompt.provenance.promptId).toBe(
      `${PRODUCT_MANAGER_ROLE_PACK_ID}#questionGeneration:${CASE_FORMAT_ID}`,
    );

    const lowered = question!.prompt.systemPrompt.toLocaleLowerCase();
    for (const marker of PHASE1_ENGINEERING_MARKERS) {
      expect(lowered, `工程口吻泄漏：${marker}`).not.toContain(marker.toLocaleLowerCase());
    }
  });

  it('一次完整的产品案例练习落到库里，四个维度都是产品量规的维度', async () => {
    const h = harness({
      evaluations: [
        evaluation({
          'problem-definition': 4,
          'user-and-market-insight': 4,
          'solution-and-prioritization': 3,
          'success-metrics': 4,
        }),
      ],
    });
    const sessionId = await openCase(h);
    await h.service.nextTurn({ sessionId, answerMd: ANSWER_MD });

    const result = await h.service.evaluate({ sessionId, answerMd: ANSWER_MD });

    expect(result.rubricId).toBe(CASE_RUBRIC_ID);
    expect(result.scores.map((score) => score.dimensionId).sort()).toEqual(
      Object.keys(QUOTES).sort(),
    );
    expect(count(h.raw, 'practice_attempt')).toBe(1);
    expect(count(h.raw, 'practice_score')).toBe(4);

    // 评分组合必须挂在产品量规上，否则分数解释不回任何一条锚点
    const scoring = h.calls.find((call) => call.slot === 'scoring');
    expect(scoring?.prompt.provenance.rubricId).toBe(CASE_RUBRIC_ID);
    expect(scoring?.prompt.provenance.rolePack).toEqual({
      id: PRODUCT_MANAGER_ROLE_PACK_ID,
      version: productManagerRolePack.manifest.version,
    });
  });

  /**
   * T17 验收：Evidence grounding 失败时不保存答案。
   *
   * 「不保存」指的是不写 attempt 与 score——候选人那一轮发言在提问前就落库了，
   * 是会话记录，不该被回撤。断言写成行数为 0 而不是「没有这一条」：留下半条
   * 无分数的 attempt 同样是坏状态，只查某一条会漏掉。
   */
  it('引文定位不到时重问一次，仍然对不上就一行都不落', async () => {
    const ungrounded = { 'problem-definition': '这句话根本不在候选人的回答里' };
    const h = harness({
      evaluations: [
        evaluation(
          {
            'problem-definition': 4,
            'user-and-market-insight': 4,
            'solution-and-prioritization': 3,
            'success-metrics': 4,
          },
          ungrounded,
        ),
        evaluation(
          {
            'problem-definition': 4,
            'user-and-market-insight': 4,
            'solution-and-prioritization': 3,
            'success-metrics': 4,
          },
          ungrounded,
        ),
      ],
    });
    const sessionId = await openCase(h);
    await h.service.nextTurn({ sessionId, answerMd: ANSWER_MD });

    expect(await rejectionCode(h.service.evaluate({ sessionId, answerMd: ANSWER_MD }))).toBe(
      'ungrounded-score',
    );

    expect(count(h.raw, 'practice_attempt')).toBe(0);
    expect(count(h.raw, 'practice_score')).toBe(0);
    // 校验不过重问了一次，两次都用掉了才判失败
    expect(h.calls.filter((call) => call.slot === 'scoring')).toHaveLength(2);
  });

  it('少给一个产品维度同样整次拒掉', async () => {
    const partial = evaluation({
      'problem-definition': 4,
      'user-and-market-insight': 4,
      'solution-and-prioritization': 3,
    });
    const h = harness({ evaluations: [partial, partial] });
    const sessionId = await openCase(h);
    await h.service.nextTurn({ sessionId, answerMd: ANSWER_MD });

    expect(await rejectionCode(h.service.evaluate({ sessionId, answerMd: ANSWER_MD }))).toBe(
      'missing-dimension',
    );
    expect(count(h.raw, 'practice_attempt')).toBe(0);
    expect(count(h.raw, 'practice_score')).toBe(0);
  });

  it('行为面题型换一套量规也照常跑通，说明多题型不是只有案例能用', async () => {
    const h = harness();

    const session = await h.service.createSession({
      campaignId: PHASE1_CAMPAIGN.id,
      nodeId: null,
      formatId: PRODUCT_MANAGER_FORMAT_IDS.behavioral,
    });

    expect(session).toMatchObject({
      protocol: 'behavioral',
      rubricId: 'pm.behavioral-rubric',
      maxFollowUps: 4,
    });
  });
});
