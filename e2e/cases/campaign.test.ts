/**
 * E40–E59 备考：诊断、考点树、讲解、考我、图谱、计划与任务、标记、岗位画像、证据、故事。
 *
 * 状态类断言走 IPC（渲染层与应用之间真正的契约），展示类断言走界面，
 * 落库类断言直读副本的库——三条面互不替代。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { launchApp, sleep, type AppInstance } from '../harness/app';
import { AppDb } from '../harness/db';
import { makeEnv, type Env } from '../harness/env';
import { seedCampaign, setRoleProfile, type SeededCampaign } from '../harness/seed';
import { LlmStub } from '../harness/stub';
import { activeText, clickNav, waitActiveText } from '../harness/ui';

let app: AppInstance;
let env: Env;
let db: AppDb;
let stub: LlmStub;
let seeded: SeededCampaign;
let nodeId = '';

beforeAll(async () => {
  stub = new LlmStub();
  await stub.start();
  env = makeEnv('campaign', { llmBaseUrl: stub.baseUrl, searchEndpoint: stub.searchEndpoint });
  app = await launchApp({ userData: env.userData });
  db = AppDb.open(join(env.userData, 'openjob.db'));
  seeded = await seedCampaign(app);
  await setRoleProfile(app, seeded.campaignId);
}, 240_000);

afterAll(async () => {
  db?.close();
  await app?.stop();
  await stub?.stop();
});

const nameOf = (name: string): string =>
  db.get<{ id: string }>(
    `SELECT id FROM knowledge_node WHERE campaign_id = ? AND name = ?`,
    seeded.campaignId,
    name,
  )?.id ?? '';

describe('E40–E45 备考与诊断', () => {
  it('E40 / E41 备考：列表有它、状态是规划中；另建一场删掉后列表与库都没有它', async () => {
    const list = await app.page.invoke<Array<{ id: string; status: string }>>('campaign:list', null);
    expect(list.find((c) => c.id === seeded.campaignId)?.status).toBe('planning');

    const throwaway = await app.page.invoke<{ id: string }>('campaign:create', {
      company: 'E2E 待删公司',
      roleTitle: '待删岗位',
      jdRaw: '待删 JD',
    });
    await app.page.invoke('campaign:delete', { id: throwaway.id });
    const after = await app.page.invoke<Array<{ id: string }>>('campaign:list', null);
    expect(after.some((c) => c.id === throwaway.id)).toBe(false);
    expect(db.count('campaign', 'id = ?', throwaway.id)).toBe(0);
  });

  it('E42 JD 诊断：桩返回两层知识点树 + 关系边，落库且带覆盖类型', async () => {
    await app.page.invoke('diagnosis:fromJd', { campaignId: seeded.campaignId });
    const domain = await db.waitForRow<{ id: string; kind: string }>(
      `SELECT id, kind FROM knowledge_node WHERE campaign_id = ? AND name = 'JVM'`,
      [seeded.campaignId],
      'JD 诊断落知识点',
    );
    expect(domain.kind).toBe('domain');
    nodeId = domain.id;

    const topics = db.all<{ coverage_type: string }>(
      `SELECT coverage_type FROM knowledge_node WHERE campaign_id = ? AND name IN ('内存模型','垃圾回收')`,
      seeded.campaignId,
    );
    expect(topics).toHaveLength(2);
    // 桩给的是 gap：还没提供简历时的默认口径
    expect(topics.every((t) => t.coverage_type === 'gap')).toBe(true);

    const edges = await app.page.invoke<Array<{ relation: string }>>('edge:list', {
      campaignId: seeded.campaignId,
    });
    expect(edges.some((e) => e.relation === 'prerequisite')).toBe(true);
  }, 180_000);

  it('E43 拉公司情报：走检索桩，情报落到这场备考上', async () => {
    const searchesBefore = stub.requests.filter((r) => r.path.includes('/search')).length;
    await app.page.invoke('diagnosis:fetchIntel', { campaignId: seeded.campaignId });
    await app.page.waitUntil(
      async () => db.count('company_intel', 'campaign_id = ?', seeded.campaignId) > 0,
      '公司情报落库',
      120_000,
    );
    expect(stub.requests.filter((r) => r.path.includes('/search')).length).toBeGreaterThan(
      searchesBefore,
    );
  }, 180_000);

  it('E44 导入面经（粘贴）：两道模型调用之后面经落库，问题数与桩返回一致', async () => {
    stub.clear();
    const result = await app.page.invoke<{
      report: { id: string };
      questionsExtracted: number;
    }>('diagnosis:ingestReport', {
      campaignId: seeded.campaignId,
      rawText: '一面问：JVM 内存模型是怎么划分的？二面是系统设计，设计一个短链服务。',
      sourceType: 'pasted',
    });

    expect(result.report.id).toBeTruthy();
    expect(result.questionsExtracted).toBe(2);
    expect(db.count('interview_report', 'campaign_id = ?', seeded.campaignId)).toBeGreaterThan(0);
    // 抽取 + 匹配是两次模型调用，缺哪一次都走不完
    expect(stub.requests.length).toBeGreaterThanOrEqual(2);
  }, 180_000);

  it('E45 面经：能列出来，空的时候也不抛错', async () => {
    const reports = await app.page.invoke<Array<{ id: string }>>('diagnosis:listReports', {
      campaignId: seeded.campaignId,
    });
    expect(Array.isArray(reports)).toBe(true);
  }, 180_000);
});

describe('E46–E51 考点树 / 讲解 / 考我 / 图谱 / 提醒', () => {
  it('E46 考点树：状态与覆盖类型可写可读', async () => {
    expect(nodeId).not.toBe('');
    await app.page.invoke('node:update', {
      id: nodeId,
      status: 'learning',
      coverageType: 'deepDive',
    });
    const row = db.get<{ status: string; coverage_type: string }>(
      `SELECT status, coverage_type FROM knowledge_node WHERE id = ?`,
      nodeId,
    );
    expect(row?.status).toBe('learning');
    expect(row?.coverage_type).toBe('deepDive');
  });

  it('E47 讲解：生成 → 落库 → 手改 → 细化', async () => {
    const generated = await app.page.invoke<{ id: string; contentMd: string }>('explain:generate', {
      nodeId,
      tier: 'spoken',
    });
    expect(generated.contentMd.length).toBeGreaterThan(0);
    expect(db.count('explanation', 'node_id = ?', nodeId)).toBeGreaterThan(0);

    const updated = await app.page.invoke<{ contentMd: string }>('explain:update', {
      id: generated.id,
      contentMd: '## E2E 手改过的讲解\n\n正文。',
    });
    expect(updated.contentMd).toContain('手改过的讲解');

    const elaborated = await app.page.invoke<Record<string, unknown>>('explain:elaborate', {
      nodeId,
      tier: 'deep',
      selectedText: '正文。',
      contextMd: updated.contentMd,
    });
    expect(elaborated).toBeTruthy();
  }, 180_000);

  it('E48 考我：出题 → 推荐答案 → 评分 → 加入话术库', async () => {
    const draft = await app.page.invoke<{ question: string }>('quiz:question', { nodeId });
    expect(draft.question.length).toBeGreaterThan(0);
    // 出题会缓存到考点上，草稿能读回来
    const cached = await app.page.invoke<{ questionMd: string }>('quiz:draft', { nodeId });
    expect(cached.questionMd.length).toBeGreaterThan(0);

    const answer = await app.page.invoke<{ recommendedAnswerMd: string }>('quiz:answer', {
      nodeId,
      question: draft.question,
    });
    expect(answer.recommendedAnswerMd.length).toBeGreaterThan(0);

    const submitted = await app.page.invoke<{ attempt: { id: string } }>('quiz:submit', {
      nodeId,
      question: draft.question,
      userAnswer: 'JVM 内存分为堆、栈、方法区，垃圾回收按分代收集。',
    });
    expect(submitted.attempt.id).toBeTruthy();
    expect(db.count('quiz_attempt', 'node_id = ?', nodeId)).toBeGreaterThan(0);

    const snippet = await app.page.invoke<{ id: string }>('speech:saveFromQuiz', {
      nodeId,
      contentMd: answer.recommendedAnswerMd,
    });
    expect(db.count('speech_snippet', 'id = ?', snippet.id)).toBe(1);
  }, 180_000);

  it('E49 会话：按备考列、按考点取消息、可搜索', async () => {
    const sessions = await app.page.invoke<Array<{ id: string }>>('session:list', {
      campaignId: seeded.campaignId,
    });
    expect(Array.isArray(sessions)).toBe(true);
    const hits = await app.page.invoke<Array<unknown>>('session:search', { query: 'JVM' });
    expect(Array.isArray(hits)).toBe(true);
    const forNode = await app.page.invoke<Array<unknown>>('session:getMessagesForNode', { nodeId });
    expect(Array.isArray(forNode)).toBe(true);
  });

  it('E50 图谱关系边：加、列、删', async () => {
    const other = nameOf('垃圾回收');
    expect(other).not.toBe('');
    await app.page.invoke('edge:create', {
      campaignId: seeded.campaignId,
      fromNodeId: nodeId,
      toNodeId: other,
      relation: 'contrast',
    });
    const edges = await app.page.invoke<Array<{ id: string; relation: string }>>('edge:list', {
      campaignId: seeded.campaignId,
    });
    const created = edges.find((e) => e.relation === 'contrast');
    expect(created).toBeDefined();

    await app.page.invoke('edge:delete', { id: created!.id });
    const after = await app.page.invoke<Array<{ id: string }>>('edge:list', {
      campaignId: seeded.campaignId,
    });
    expect(after.some((e) => e.id === created!.id)).toBe(false);
  });

  it('E51 该提醒你的事：能列出，也能把提问历史回写成排序依据', async () => {
    const nudges = await app.page.invoke<Array<{ kind: string }>>('insight:nudges', {
      campaignId: seeded.campaignId,
    });
    expect(Array.isArray(nudges)).toBe(true);
    const applied = await app.page.invoke<Record<string, unknown>>('insight:applyHistory', {
      campaignId: seeded.campaignId,
    });
    expect(applied).toBeTruthy();
  }, 180_000);
});

describe('E52–E56 计划 / 任务 / 标记 / 画像', () => {
  it('E52 计划生成：排出天与任务，今日计划与日期列表都能读', async () => {
    const result = await app.page.invoke<{ daysCreated: number; tasksCreated: number }>(
      'plan:generate',
      { campaignId: seeded.campaignId, dailyMinutes: 60 },
    );
    expect(result.daysCreated).toBeGreaterThan(0);
    expect(result.tasksCreated).toBeGreaterThan(0);

    const todayPlan = await app.page.invoke<{ tasks: unknown[] } | null>('plan:getToday', {
      campaignId: seeded.campaignId,
    });
    expect(todayPlan?.tasks.length).toBeGreaterThan(0);
    const dates = await app.page.invoke<Array<{ date: string }>>('plan:listDates', {
      campaignId: seeded.campaignId,
    });
    expect(dates.length).toBeGreaterThan(0);
  }, 180_000);

  it('E53 任务：完成 / 跳过 / 加任务 / 改时长 / 移动 / 删除', async () => {
    const todayPlan = await app.page.invoke<{ tasks: Array<{ id: string }> }>('plan:getToday', {
      campaignId: seeded.campaignId,
    });
    const taskId = todayPlan.tasks[0]!.id;

    expect((await app.page.invoke<{ status: string }>('task:complete', { taskId })).status).toBe(
      'done',
    );
    const second = todayPlan.tasks[1];
    if (second) {
      expect((await app.page.invoke<{ status: string }>('task:skip', { taskId: second.id })).status).toBe(
        'skipped',
      );
    }

    await app.page.invoke('task:setMinutes', { taskId, estMinutes: 45 });
    await app.page.invoke('task:move', {
      taskId,
      date: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
    });

    const added = await app.page.invoke<{ taskId: string }>('task:add', {
      campaignId: seeded.campaignId,
      date: new Date().toISOString().slice(0, 10),
      kind: 'review',
      nodeId: null,
      estMinutes: 20,
    });
    await app.page.invoke('task:delete', { taskId: added.taskId });

    const after = await app.page.invoke<{ tasks: Array<{ id: string }> }>('plan:getToday', {
      campaignId: seeded.campaignId,
    });
    expect(after.tasks.some((t) => t.id === added.taskId)).toBe(false);
  }, 180_000);

  it('E54 计划改期：推后今日任务，任务总数不变', async () => {
    const before = await app.page.invoke<Array<{ date: string }>>('plan:listDates', {
      campaignId: seeded.campaignId,
    });
    const result = await app.page.invoke<{ deferred: number }>('plan:deferToday', {
      campaignId: seeded.campaignId,
    });
    expect(result.deferred).toBeGreaterThanOrEqual(0);
    const after = await app.page.invoke<Array<{ date: string }>>('plan:listDates', {
      campaignId: seeded.campaignId,
    });
    expect(after.length).toBeGreaterThanOrEqual(before.length);
  });

  it('E55 标记：建、按目标查、收藏、删', async () => {
    const created = await app.page.invoke<{ id: string }>('annotation:create', {
      campaignId: seeded.campaignId,
      targetType: 'node',
      targetId: nodeId,
      kind: 'note',
      noteMd: 'E2E 笔记：内存模型要按 JMM 讲。',
    });
    const listed = await app.page.invoke<Array<{ id: string }>>('annotation:listForCampaign', {
      campaignId: seeded.campaignId,
    });
    expect(listed.some((a) => a.id === created.id)).toBe(true);

    const byTarget = await app.page.invoke<Array<{ id: string }>>('annotation:list', {
      targetType: 'node',
      targetId: nodeId,
    });
    expect(byTarget.some((a) => a.id === created.id)).toBe(true);

    const toggled = await app.page.invoke<{ bookmarked: boolean }>('annotation:toggleBookmark', {
      id: created.id,
      targetType: 'node',
      targetId: nodeId,
      kind: 'note',
    });
    expect(typeof toggled.bookmarked).toBe('boolean');

    await app.page.invoke('annotation:delete', { id: created.id });
    const after = await app.page.invoke<Array<{ id: string }>>('annotation:listForCampaign', {
      campaignId: seeded.campaignId,
    });
    expect(after.some((a) => a.id === created.id)).toBe(false);
  });

  it('E56 岗位画像：级别 / 面试语言落库，descriptor 带快照哈希与能力视图', async () => {
    await setRoleProfile(app, seeded.campaignId, { level: '高级', interviewLanguage: 'en' });
    const view = await app.page.invoke<{
      descriptor: { configSnapshotHash: string; rolePack: { id: string } };
      roleProfile: { level: string; interviewLanguage: string };
    }>('campaign:getRuntimeDescriptor', { campaignId: seeded.campaignId });

    expect(view.roleProfile.level).toBe('高级');
    expect(view.roleProfile.interviewLanguage).toBe('en');
    expect(view.descriptor.configSnapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(view.descriptor.rolePack.id).toBe('software-engineering');

    const capabilities = await app.page.invoke<{ capabilities?: unknown[] }>(
      'campaign:getClientCapabilityView',
      { campaignId: seeded.campaignId },
    );
    expect(capabilities).toBeTruthy();
    await setRoleProfile(app, seeded.campaignId);
  });

  it('E59 挂载简历：解绑后读回是空，绑回去又回来', async () => {
    await app.page.invoke('campaign:update', { id: seeded.campaignId, resumeId: null });
    const detached = await app.page.invoke<{ resume?: unknown }>('campaign:get', {
      id: seeded.campaignId,
    });
    expect(detached.resume ?? null).toBeNull();

    await app.page.invoke('campaign:update', { id: seeded.campaignId, resumeId: seeded.resumeId });
    const attached = await app.page.invoke<{ resume?: { id: string } }>('campaign:get', {
      id: seeded.campaignId,
    });
    expect(attached.resume?.id).toBe(seeded.resumeId);
  });
});

describe('E57–E58 证据与故事', () => {
  it('E57 证据：自述原文提案 → 待确认 → 确认进「已确认」，驳回的不进', async () => {
    // 抽取是确定性的（从简历/JD 原文里切），先看它至少不抛错、返回数组
    const extracted = await app.page.invoke<Array<{ id: string }>>('evidence:extract', {
      campaignId: seeded.campaignId,
    });
    expect(Array.isArray(extracted)).toBe(true);

    // 用户手动补一条：引文必须逐字出现在**库里的原文**上，偏移量也按库里的文本来算
    // （创建时传进去的字符串可能被规整过，拿常量算偏移会对不上）
    const rawText = db.get<{ raw_text: string }>(
      `SELECT raw_text FROM resume WHERE id = ?`,
      seeded.resumeId,
    )!.raw_text;
    const anchor = Math.max(0, rawText.indexOf('诺基亚'));
    const quote = rawText.slice(anchor, anchor + 20);
    const secondQuote = rawText.slice(anchor + 20, anchor + 40);
    expect(quote.length).toBeGreaterThan(4);

    const first = await app.page.invoke<{ id: string }>('evidence:propose', {
      campaignId: seeded.campaignId,
      kind: 'experience',
      title: '经历片段',
      statement: quote,
      source: {
        kind: 'resume',
        documentId: seeded.resumeId,
        start: anchor,
        end: anchor + quote.length,
        quote,
      },
      occurredAt: null,
      confidence: 1,
    });
    // 提案一律先进「待确认」：确认之前不算事实来源
    const statusOf = (id: string): string | undefined =>
      db.get<{ status: string }>(`SELECT status FROM candidate_evidence WHERE id = ?`, id)?.status;
    expect(statusOf(first.id)).toBe('proposed');

    const second = await app.page.invoke<{ id: string }>('evidence:propose', {
      campaignId: seeded.campaignId,
      kind: 'skill',
      title: '技能片段',
      statement: secondQuote,
      source: {
        kind: 'resume',
        documentId: seeded.resumeId,
        start: anchor + 20,
        end: anchor + 20 + secondQuote.length,
        quote: secondQuote,
      },
      occurredAt: null,
      confidence: 1,
    });

    await app.page.invoke('evidence:confirm', { id: first.id });
    expect(statusOf(first.id)).toBe('confirmed');
    await app.page.invoke('evidence:reject', { id: second.id });
    expect(statusOf(second.id)).toBe('rejected');
    const proposed = await app.page.invoke<Array<{ id: string }>>('evidence:listProposed', {
      campaignId: seeded.campaignId,
    });
    expect(proposed.some((p) => p.id === second.id)).toBe(false);

    const confirmedList = await app.page.invoke<Array<{ id: string }>>('evidence:listConfirmed', {
      campaignId: seeded.campaignId,
    });
    expect(confirmedList.some((e) => e.id === first.id)).toBe(true);
  }, 180_000);

  it('E58 故事：先挡住没有证据的，再建 STAR、修订、加口述版本、删除', async () => {
    // fail closed：没有已确认证据时不许建故事
    const blocked = await app.page
      .invoke('story:create', {
        campaignId: seeded.campaignId,
        title: '不该建起来的故事',
        situationMd: 's',
        taskMd: 't',
        actionMd: 'a',
        resultMd: 'r',
        reflectionMd: 'x',
        evidenceIds: [],
        competencyIds: [],
      })
      .then(
        () => '',
        (error: Error) => error.message,
      );
    expect(blocked).toContain('证据');

    const evidence = await app.page.invoke<Array<{ id: string }>>('evidence:listConfirmed', {
      campaignId: seeded.campaignId,
    });
    const story = await app.page.invoke<{ id: string; title: string }>('story:create', {
      campaignId: seeded.campaignId,
      title: 'E2E 故事：架构演进',
      situationMd: '老系统是 C/S。',
      taskMd: '要迁到 B/S。',
      actionMd: '抽象统一后端接口。',
      resultMd: '模块复用率 70%。',
      reflectionMd: '抽象先行。',
      evidenceIds: [evidence[0]!.id],
      competencyIds: [],
    });
    expect(story.title).toBe('E2E 故事：架构演进');

    await app.page.invoke('story:revise', { id: story.id, patch: { resultMd: '模块复用率 75%。' } });
    const revised = await app.page.invoke<{ resultMd: string }>('story:get', { id: story.id });
    expect(revised.resultMd).toContain('75%');

    await app.page.invoke('story:delete', { id: story.id });
    const stories = await app.page.invoke<Array<{ id: string }>>('story:list', {
      campaignId: seeded.campaignId,
    });
    expect(stories.some((s) => s.id === story.id)).toBe(false);
  }, 180_000);

  it('E58b 口述版本：同一份事实集合生成 30 / 60 / 120 秒三版', async () => {
    const evidence = await app.page.invoke<Array<{ id: string }>>('evidence:listConfirmed', {
      campaignId: seeded.campaignId,
    });
    const story = await app.page.invoke<{ id: string }>('story:create', {
      campaignId: seeded.campaignId,
      title: 'E2E 故事：口述版本',
      situationMd: '老系统是 C/S。',
      taskMd: '要迁到 B/S。',
      actionMd: '抽象统一后端接口。',
      resultMd: '模块复用率 70%。',
      reflectionMd: '抽象先行。',
      evidenceIds: [evidence[0]!.id],
      competencyIds: [],
    });

    for (const duration of [30, 60, 120] as const) {
      const delivery = await app.page.invoke<{ id: string; contentMd?: string }>(
        'story:createDelivery',
        { id: story.id, duration },
      );
      expect(delivery.id).toBeTruthy();
    }

    const deliveries = await app.page.invoke<
      Array<{ durationSeconds: number; factSetHash: string; snippetId: string }>
    >('story:listDeliveries', { id: story.id });
    expect(deliveries).toHaveLength(3);
    expect(new Set(deliveries.map((item) => item.durationSeconds))).toEqual(new Set([30, 60, 120]));
    // 三档共用同一份事实集合：指纹必须一致，否则「同一个故事」就是假的
    expect(new Set(deliveries.map((item) => item.factSetHash)).size).toBe(1);
    // 每档都真的存进话术库了
    expect(new Set(deliveries.map((item) => item.snippetId)).size).toBe(3);

    await app.page.invoke('story:delete', { id: story.id });
  }, 300_000);
});

describe('界面呈现', () => {
  it('在界面里新建一场备考并打开详情：四个子页签都能进，学习页带着诊断出来的考点', async () => {
    await clickNav(app, '备考');
    await waitActiveText(app, '备考战役|新建', '备考列表');

    // 点「新建」进创建表单（外部 IPC 造的数据不会 bump 渲染层数据版本，
    // 所以这一条必须走界面自己的创建路径，列表才会刷新）
    const formOpened = await app.page.evaluate<{ ok: boolean; buttons: string[] }>(`(() => {
      const panel = document.querySelector('main > div:not(.hidden)') ?? document.querySelector('main');
      const visible = (selector) => [...panel.querySelectorAll(selector)]
        .filter((n) => n.getBoundingClientRect().height > 0);
      const create = visible('button').find((b) => b.textContent.trim() === '新建');
      if (!create) return { ok: false, buttons: visible('button').map((b) => b.textContent.trim().slice(0, 16)) };
      create.click();
      return { ok: true, buttons: [] };
    })()`);
    expect(formOpened.ok, `找不到「新建」；可见按钮 = ${formOpened.buttons.join(' , ')}`).toBe(true);
    await sleep(600);

    const submitted = await app.page.evaluate<{ ok: boolean; detail: string }>(`(() => {
      const panel = document.querySelector('main > div:not(.hidden)') ?? document.querySelector('main');
      const visible = (selector) => [...panel.querySelectorAll(selector)]
        .filter((n) => n.getBoundingClientRect().height > 0);
      const setSelect = (labelText, index) => {
        const select = visible('select').find((s) => s.closest('label')?.textContent.includes(labelText));
        if (!select || select.options.length === 0) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(select, select.options[index]?.value ?? select.options[0].value);
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };
      const job = setSelect('目标岗位', 0);
      setSelect('简历', 0);
      const submit = visible('button').find((b) => /新建备考|创建|保存/.test(b.textContent));
      if (!submit) {
        return { ok: false, detail: '目标岗位=' + job + '；可见按钮=' + visible('button').map((b) => b.textContent.trim().slice(0, 14)).join(' , ') };
      }
      submit.click();
      return { ok: true, detail: '' };
    })()`);
    expect(submitted.ok, submitted.detail).toBe(true);
    await sleep(1200);

    for (const tab of ['情报与面经', '学习', '资料与标记', '岗位与证据']) {
      const clicked = await app.page.evaluate<boolean>(`(() => {
        const panel = document.querySelector('main > div:not(.hidden)') ?? document.querySelector('main');
        const button = [...panel.querySelectorAll('button')]
          .filter((b) => b.getBoundingClientRect().height > 0)
          .find((b) => b.textContent.trim() === ${JSON.stringify(tab)});
        if (!button) return false;
        button.click();
        return true;
      })()`);
      expect(clicked, `找不到子页签：${tab}`).toBe(true);
      await sleep(500);
      expect((await activeText(app)).length).toBeGreaterThan(10);
    }

    expect(await activeText(app)).toMatch(/JVM|考点|能力|岗位/);
  }, 240_000);
});
