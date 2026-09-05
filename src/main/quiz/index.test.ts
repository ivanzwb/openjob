/**
 * 考我三件套喂给模型的 user message 必须带简历。
 *
 * 这三个调用点原来只给「公司/岗位/考点」，模型要举例只能照岗位名编一段候选人
 * 经历——用户报的「把要面的岗位当成我做过的项目」就是从这儿来的。用例守的是
 * 简历经历块必须出现在 user message 里，以及没有简历时必须明说没有。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';

type CampaignRow = typeof schema.campaign.$inferSelect;
type NodeRow = typeof schema.knowledgeNode.$inferSelect;
type ResumeRow = typeof schema.resume.$inferSelect;

const dbRef = vi.hoisted(() => ({ current: null as unknown }));
const llm = vi.hoisted(() => ({ calls: [] as Array<{ promptId: string; user: string }> }));

vi.mock('../db', async () => {
  const real = await import('../db/schema');
  return { getDb: () => dbRef.current, schema: real };
});

vi.mock('../llm/json', () => ({
  completeJson: (_role: string, promptId: string, user: string) => {
    llm.calls.push({ promptId, user });
    const canned: Record<string, unknown> = {
      'quiz.question': { question: '说说你怎么保证消费幂等' },
      'quiz.answer': { answerMd: '参考答案' },
      'quiz.score': { score: 4, feedbackMd: '反馈', improvedScriptMd: '' },
    };
    return Promise.resolve(canned[promptId]);
  },
}));

// 语音落库与优先级都依赖 electron（dialog / config），与本用例无关
vi.mock('../speech', () => ({ saveSpeechFromQuiz: () => undefined }));
vi.mock('../diagnosis/priority', () => ({
  computePriority: () => ({ score: 1 }),
  attachPriorityReason: (node: unknown) => node,
}));

const { generateQuizAnswer, generateQuizQuestion, submitQuizAnswer } = await import('./index');

const RESUME_MD = `## 专业技能

- 后端：Go、Kafka、PostgreSQL

## 工作经历

### 涌泉科技 | 后端工程师 | 2021-04 ~ 至今

- 重构对账中心，用 Kafka 做异步削峰并处理消费端幂等，日终跑批从 40 分钟压到 6 分钟

## 项目经历

### 实时风控看板 | 主力开发 | 2019-06 ~ 2021-03

- 用 Flink 做实时指标聚合，前端用 React 画大盘
`;

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
  jdParsed: {
    roleTitle: '资深 Go 工程师',
    requirements: [{ skill: 'Kubernetes', weight: 0.8 }],
    seniority: '高级',
  },
  jobTargetId: null,
  roleProfileId: null,
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
  rawText: RESUME_MD,
  parsed: { skills: ['Go', 'Kafka'], projects: [], yearsOfExperience: 5 },
  previewStyle: null,
  photo: null,
  createdAt: 0,
  updatedAt: 0,
};

/** 只实现考我路径用到的那几条 drizzle 链，按表返回对应行 */
function fakeDb(rows: { campaign: CampaignRow; resume: ResumeRow | null }): void {
  const rowFor = (table: unknown): unknown => {
    if (table === schema.knowledgeNode) return nodeRow;
    if (table === schema.campaign) return rows.campaign;
    if (table === schema.resume) return rows.resume;
    return null;
  };
  dbRef.current = {
    select: () => ({
      from: (table: unknown) => ({ where: () => ({ get: () => rowFor(table), all: () => [] }) }),
    }),
    update: () => ({ set: () => ({ where: () => ({ run: () => undefined }) }) }),
    insert: () => ({ values: () => ({ run: () => undefined }) }),
  };
}

function userMessage(promptId: string): string {
  const call = llm.calls.find((c) => c.promptId === promptId);
  if (!call) throw new Error(`没有调用 ${promptId}`);
  return call.user;
}

/** 经历块的固定抬头，来自 shared 的 relevantResumeExperienceBlock */
const EXPERIENCE_HEADER = '简历经历（按与本题的关键词重叠度粗排';

beforeEach(() => {
  llm.calls = [];
  fakeDb({ campaign: campaignRow, resume: resumeRow });
});

describe('考我三件套注入简历上下文', () => {
  it('出题：user message 带公司岗位、JD 摘要、考点与简历经历', async () => {
    await generateQuizQuestion('n1');

    const user = userMessage('quiz.question');
    expect(user).toContain('公司：星舰科技');
    expect(user).toContain('岗位：资深 Go 工程师');
    expect(user).toContain('职级：高级');
    expect(user).toContain('考点：消息队列幂等消费');
    expect(user).toContain(EXPERIENCE_HEADER);
    // 打在考点上的那段排前面，无关的那段仍然给，但排后面
    expect(user.indexOf('涌泉科技')).toBeGreaterThan(-1);
    expect(user.indexOf('实时风控看板')).toBeGreaterThan(user.indexOf('涌泉科技'));
  });

  it('简历一段都打不到考点时不下「没有相关经历」的结论，交给模型判断', async () => {
    // 词法跨不过同义词，「打不中」不等于「没做过」。这里给的是明确的用法说明，
    // 而不是替模型把经历都扣掉。
    fakeDb({
      campaign: campaignRow,
      resume: {
        ...resumeRow,
        rawText: `## 工作经历

### 某前端公司 | 前端工程师 | 2021-04 ~ 至今

- 用 React 重写管理后台，做了组件库和权限路由
`,
      },
    });

    await generateQuizQuestion('n1');

    const user = userMessage('quiz.question');
    expect(user).toContain('某前端公司');
    expect(user).toContain('先判断上面哪几段与本题真的相关');
    expect(user).toContain('若都不相关');
  });

  it('参考答案：带简历经历，且保留原来的问题行', async () => {
    await generateQuizAnswer('n1', '如何保证幂等？');

    const user = userMessage('quiz.answer');
    expect(user).toContain(EXPERIENCE_HEADER);
    expect(user).toContain('涌泉科技');
    expect(user).toContain('问题：如何保证幂等？');
  });

  it('评分：带简历经历，且保留问题与候选人回答', async () => {
    await submitQuizAnswer('n1', '如何保证幂等？', '用唯一键去重');

    const user = userMessage('quiz.score');
    expect(user).toContain(EXPERIENCE_HEADER);
    expect(user).toContain('涌泉科技');
    expect(user).toContain('问题：如何保证幂等？');
    expect(user).toContain('候选人回答：用唯一键去重');
  });

  it('战役没关联简历：明确写出没有简历，而不是留白', async () => {
    fakeDb({ campaign: { ...campaignRow, resumeId: null }, resume: null });

    await generateQuizQuestion('n1');

    const user = userMessage('quiz.question');
    expect(user).toContain('尚未关联简历');
    expect(user).not.toContain(EXPERIENCE_HEADER);
  });
});
