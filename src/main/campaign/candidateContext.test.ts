/**
 * 追问的 system prompt 必须在主进程重建。
 *
 * 渲染层只知道考点名，简历只能在这里查出来注入；查不到考点时必须退回渲染层
 * 那份，否则一次追问会直接失败。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';

type CampaignRow = typeof schema.campaign.$inferSelect;
type NodeRow = typeof schema.knowledgeNode.$inferSelect;
type ResumeRow = typeof schema.resume.$inferSelect;

const dbRef = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../db', async () => {
  const real = await import('../db/schema');
  return { getDb: () => dbRef.current, schema: real };
});

// 优先级依赖 electron 侧的配置，与本用例无关
vi.mock('../diagnosis/priority', () => ({
  computePriority: () => ({ score: 1 }),
  attachPriorityReason: (node: unknown) => node,
}));

const { buildNodeFollowUpSystem } = await import('./candidateContext');

const nodeRow: NodeRow = {
  id: 'n1',
  campaignId: 'c1',
  parentId: null,
  name: '消息队列幂等消费',
  kind: 'topic',
  coverageType: 'deepDive',
  examProb: 0.8,
  difficulty: 4,
  estMinutes: 30,
  examForms: ['concept'],
  mastery: 2,
  masterySource: 'self',
  priorityScore: 1,
  status: 'learning',
  embedding: null,
  isUserAdded: false,
  quizQuestionMd: null,
  quizRecommendedAnswerMd: null,
  quizAnswerDraftMd: null,
  createdAt: 0,
};

const campaignRow: CampaignRow = {
  id: 'c1',
  company: '星舰科技',
  roleTitle: '资深 Go 工程师',
  jdRaw: 'JD 原文',
  jdParsed: null,
  jobTargetId: null,
  resumeId: 'r1',
  interviewDate: null,
  dailyMinutes: null,
  status: 'active',
  createdAt: 0,
  updatedAt: 0,
};

const resumeRow: ResumeRow = {
  id: 'r1',
  label: '主简历',
  rawText: `## 工作经历

### 涌泉科技 | 后端工程师 | 2021-04 ~ 至今

- 重构对账中心，用 Kafka 做异步削峰并处理消费端幂等，日终跑批从 40 分钟压到 6 分钟

### 早年公司 | 前端工程师 | 2018-01 ~ 2021-03

- 用 React 写管理后台
`,
  parsed: { skills: ['Go', 'Kafka'], projects: [], yearsOfExperience: 5 },
  previewStyle: null,
  photo: null,
  createdAt: 0,
  updatedAt: 0,
};

function fakeDb(node: NodeRow | null): void {
  const rowFor = (table: unknown): unknown => {
    if (table === schema.knowledgeNode) return node;
    if (table === schema.campaign) return campaignRow;
    if (table === schema.resume) return resumeRow;
    return null;
  };
  dbRef.current = {
    select: () => ({
      from: (table: unknown) => ({ where: () => ({ get: () => rowFor(table), all: () => [] }) }),
    }),
  };
}

beforeEach(() => {
  fakeDb(nodeRow);
});

describe('buildNodeFollowUpSystem', () => {
  it('把考点、公司岗位与简历经历一起写进 system prompt', () => {
    const prompt = buildNodeFollowUpSystem('n1', '兜底');

    expect(prompt).toContain('消息队列幂等消费');
    expect(prompt).toContain('公司：星舰科技');
    expect(prompt).toContain('简历经历（按与本题的关键词重叠度粗排');
    // 打在考点上的那段排前面，其余的仍然给，由模型自己判断相关性
    expect(prompt.indexOf('涌泉科技')).toBeGreaterThan(-1);
    expect(prompt.indexOf('早年公司')).toBeGreaterThan(prompt.indexOf('涌泉科技'));
  });

  it('考点查不到时退回渲染层传来的 prompt', () => {
    fakeDb(null);

    expect(buildNodeFollowUpSystem('n1', '兜底')).toBe('兜底');
  });

  it('没有 nodeId 时不查库，直接用兜底', () => {
    dbRef.current = null;

    expect(buildNodeFollowUpSystem(undefined, '兜底')).toBe('兜底');
  });
});
