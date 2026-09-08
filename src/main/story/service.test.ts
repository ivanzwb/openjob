/**
 * StoryService 的端到端用例：真迁移建库，真组合 Prompt，真落库。
 *
 * 四条验收边界都在这里过一遍数据库，因为它们全部是「库里能不能留下某种状态」的
 * 断言，纯函数层验不出来：
 *
 * 1. Story 至少关联一个已确认 Evidence —— create 与 revise 两侧；
 * 2. 不同口述版本共享事实集合 —— 三档的 fact_set_hash 必须同一个；
 * 3. 删 Story 不删 Evidence —— candidate_evidence 逐行比对；
 * 4. Speech source 支持 story —— 口述正文落在 speech_snippet 上。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import type { ComposedPrompt } from '@shared/prompts/composer';
import {
  buildStoryFactSet,
  renderStoryFactSet,
  STORY_DELIVERY_DURATIONS,
  StoryError,
} from '@shared/story';
import {
  CAMPAIGN_ID,
  countRows,
  evidenceRows,
  newStoryDb,
  OTHER_CAMPAIGN_EVIDENCE_ID,
  PROPOSED_EVIDENCE_ID,
  STORY_INPUT,
  TEAM_EVIDENCE_ID,
  THROUGHPUT_EVIDENCE_ID,
} from './__fixtures__/storyDb';
import { listConfirmedStoryEvidence } from './repository';
import { createStoryService, type StoryService } from './service';

/** 一段只用了事实集合里已有数字的口述，正常路径下模型该给出的东西 */
const GROUNDED_DELIVERY =
  '大促前履约链路老超时，我拆了异步补偿队列、重写幂等键，高峰 QPS 从 3000 做到 12000，对账差异归零。';

interface LlmCall {
  systemPrompt: string;
  user: string;
}

interface Harness {
  api: StoryService;
  calls: LlmCall[];
}

function harness(raw: Database, replies: string[] = [GROUNDED_DELIVERY]): Harness {
  const calls: LlmCall[] = [];
  let counter = 0;
  let reply = 0;
  const api = createStoryService({
    raw,
    completeJson: async <T>(request: { prompt: ComposedPrompt; user: string }): Promise<T> => {
      calls.push({ systemPrompt: request.prompt.systemPrompt, user: request.user });
      const text = replies[Math.min(reply, replies.length - 1)];
      reply += 1;
      return { deliveryMd: text } as T;
    },
    now: () => 2000 + counter,
    newId: () => `id-${(counter += 1)}`,
  });
  return { api, calls };
}

let raw: Database;

beforeEach(() => {
  raw = newStoryDb();
});

describe('Story 至少关联一个已确认 Evidence', () => {
  it('一条证据都不给时 create 直接拒，库里不留半条 Story', async () => {
    const { api } = harness(raw);

    await expect(api.create({ ...STORY_INPUT, evidenceIds: [] })).rejects.toMatchObject({
      code: 'missing-evidence',
    });
    expect(countRows(raw, 'story')).toBe(0);
  });

  it('只给待确认的 proposal 同样拒——未确认的东西还不算一件成立的事', async () => {
    const { api } = harness(raw);

    await expect(
      api.create({ ...STORY_INPUT, evidenceIds: [PROPOSED_EVIDENCE_ID] }),
    ).rejects.toMatchObject({ code: 'invalid-evidence' });
    expect(countRows(raw, 'story')).toBe(0);
    expect(countRows(raw, 'story_evidence')).toBe(0);
  });

  it('拿另一场备考的证据接过来也拒：那等于把上一次面试的经历接到这个岗位上', async () => {
    const { api } = harness(raw);

    await expect(
      api.create({
        ...STORY_INPUT,
        evidenceIds: [THROUGHPUT_EVIDENCE_ID, OTHER_CAMPAIGN_EVIDENCE_ID],
      }),
    ).rejects.toMatchObject({ code: 'invalid-evidence' });
    expect(countRows(raw, 'story')).toBe(0);
  });

  it('合法输入才落库，关联关系与 Story 一起可读回来', async () => {
    const { api } = harness(raw);
    const story = await api.create(STORY_INPUT);

    expect(story.evidenceIds).toEqual([THROUGHPUT_EVIDENCE_ID, TEAM_EVIDENCE_ID]);
    expect(api.get(story.id)?.title).toBe(STORY_INPUT.title);
    expect(api.list(CAMPAIGN_ID).map((item) => item.id)).toEqual([story.id]);
  });

  it('revise 把证据清空会被拒，原来的关联一条不少', async () => {
    const { api } = harness(raw);
    const story = await api.create(STORY_INPUT);

    await expect(api.revise(story.id, { evidenceIds: [] })).rejects.toMatchObject({
      code: 'missing-evidence',
    });
    expect(api.get(story.id)?.evidenceIds).toEqual([THROUGHPUT_EVIDENCE_ID, TEAM_EVIDENCE_ID]);
  });

  it('关联的证据全被拒掉之后，连只改标题都不允许——整笔回滚', async () => {
    // 只在新建时挡是个假门槛：先撤证据再顺手改个标题，库里就留下一段没有任何
    // 事实支撑、却仍会被反复口述的经历。
    const { api } = harness(raw);
    const story = await api.create(STORY_INPUT);
    raw.prepare(`UPDATE candidate_evidence SET status = 'rejected' WHERE campaign_id = ?`).run(
      CAMPAIGN_ID,
    );

    await expect(api.revise(story.id, { title: '改个更好听的标题' })).rejects.toMatchObject({
      code: 'missing-evidence',
    });
    expect(api.get(story.id)?.title).toBe(STORY_INPUT.title);
  });

  it('证据都不再是已确认状态时，口述也生不出来', async () => {
    const { api, calls } = harness(raw);
    const story = await api.create(STORY_INPUT);
    raw
      .prepare(`UPDATE candidate_evidence SET status = 'rejected' WHERE id = ?`)
      .run(THROUGHPUT_EVIDENCE_ID);
    raw.prepare(`UPDATE candidate_evidence SET status = 'rejected' WHERE id = ?`).run(
      TEAM_EVIDENCE_ID,
    );

    await expect(api.createDelivery(story.id, 60)).rejects.toMatchObject({
      code: 'missing-evidence',
    });
    // 连模型都没被叫起来：没有事实可讲的时候不该先生成再删
    expect(calls).toHaveLength(0);
  });

  it('部分证据被拒时，口述只会用剩下那条', async () => {
    const { api, calls } = harness(raw);
    const story = await api.create(STORY_INPUT);
    raw.prepare(`UPDATE candidate_evidence SET status = 'rejected' WHERE id = ?`).run(
      TEAM_EVIDENCE_ID,
    );

    await api.createDelivery(story.id, 60);

    expect(calls[0].systemPrompt).toContain(THROUGHPUT_EVIDENCE_ID);
    expect(calls[0].systemPrompt).not.toContain(TEAM_EVIDENCE_ID);
  });
});

describe('不同口述版本共享事实集合', () => {
  it('三档落库后事实集合指纹完全相同，且等于当前 Story 推导出的那一份', async () => {
    const { api } = harness(raw);
    const story = await api.create(STORY_INPUT);

    for (const duration of STORY_DELIVERY_DURATIONS) {
      await api.createDelivery(story.id, duration);
    }

    const expected = buildStoryFactSet(
      api.get(story.id)!,
      listConfirmedStoryEvidence(raw, story.id),
    ).hash;
    const deliveries = api.listDeliveries(story.id);

    expect(deliveries.map((item) => item.durationSeconds)).toEqual([30, 60, 120]);
    expect(new Set(deliveries.map((item) => item.factSetHash))).toEqual(new Set([expected]));
  });

  it('三档拿到的事实段落逐字相同，只有压缩要求不同', async () => {
    const { api, calls } = harness(raw);
    const story = await api.create(STORY_INPUT);
    const factSet = buildStoryFactSet(
      api.get(story.id)!,
      listConfirmedStoryEvidence(raw, story.id),
    );

    for (const duration of STORY_DELIVERY_DURATIONS) {
      await api.createDelivery(story.id, duration);
    }

    const rendered = renderStoryFactSet(factSet);
    for (const call of calls) {
      expect(call.user).toContain(rendered);
    }
    expect(calls.map((call) => call.user.includes('30 秒'))).toEqual([true, false, false]);
  });

  it('口述里冒出事实集合之外的数字，重试一次仍然如此就不落库', async () => {
    const invented = 'QPS 从 3000 提到 12000，超时率还下降了 87%。';
    const { api, calls } = harness(raw, [invented, invented]);
    const story = await api.create(STORY_INPUT);

    await expect(api.createDelivery(story.id, 60)).rejects.toMatchObject({
      code: 'ungrounded-delivery',
    });
    // 一次带诊断的重试是给模型的机会，但机会用完就停：多出来的指标会被用户
    // 当成自己的战绩背下去，面试官一追问就对不上
    expect(calls).toHaveLength(2);
    expect(calls[1].user).toContain('87');
    expect(countRows(raw, 'story_delivery')).toBe(0);
    expect(countRows(raw, 'speech_snippet')).toBe(0);
  });

  it('重试给出合规内容时照常落库', async () => {
    const { api, calls } = harness(raw, ['提升了 87%。', GROUNDED_DELIVERY]);
    const story = await api.create(STORY_INPUT);

    const snippet = await api.createDelivery(story.id, 60);

    expect(snippet.contentMd).toBe(GROUNDED_DELIVERY);
    expect(calls).toHaveLength(2);
  });

  it('同一档重新生成是替换，不是再攒一条', async () => {
    const second = '大促前履约链路老超时，我把重试摘出主链路，QPS 做到 12000。';
    const { api } = harness(raw, [GROUNDED_DELIVERY, second]);
    const story = await api.create(STORY_INPUT);

    await api.createDelivery(story.id, 60);
    await api.createDelivery(story.id, 60);

    const deliveries = api.listDeliveries(story.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].contentMd).toBe(second);
    // 旧正文一起走，否则话术库里同一档留两条内容不同的口述
    expect(countRows(raw, 'speech_snippet')).toBe(1);
  });

  it('改过 Story 正文之后指纹跟着变，旧口述能被认出是旧事实上生成的', async () => {
    const { api } = harness(raw);
    const story = await api.create(STORY_INPUT);
    await api.createDelivery(story.id, 30);
    const before = api.listDeliveries(story.id)[0].factSetHash;

    await api.revise(story.id, { resultMd: '大促当天超时清零，且对账差异归零。' });
    const current = buildStoryFactSet(
      api.get(story.id)!,
      listConfirmedStoryEvidence(raw, story.id),
    ).hash;

    expect(current).not.toBe(before);
    expect(api.listDeliveries(story.id)[0].factSetHash).toBe(before);
  });
});

describe('删除 Story 不删除 Evidence', () => {
  it('Story 和它的口述都清干净，candidate_evidence 逐行不动', async () => {
    const { api } = harness(raw);
    const story = await api.create(STORY_INPUT);
    await api.createDelivery(story.id, 60);
    const before = evidenceRows(raw);

    api.remove(story.id);

    expect(countRows(raw, 'story')).toBe(0);
    expect(countRows(raw, 'story_evidence')).toBe(0);
    expect(countRows(raw, 'story_delivery')).toBe(0);
    // 口述话术反过来必须跟着删：Story 没了之后它既显示不出来源，也追不回证据
    expect(countRows(raw, 'speech_snippet')).toBe(0);
    // 讲法可以推翻重写，做过的事不会因此消失——而且同一条证据还挂在别的题目上
    expect(evidenceRows(raw)).toEqual(before);
  });

  it('删掉一个 Story 不影响另一个 Story 对同一条证据的关联', async () => {
    const { api } = harness(raw);
    const first = await api.create(STORY_INPUT);
    const second = await api.create({
      ...STORY_INPUT,
      title: '同一条证据的另一种讲法',
      evidenceIds: [THROUGHPUT_EVIDENCE_ID],
    });

    api.remove(first.id);

    expect(api.get(second.id)?.evidenceIds).toEqual([THROUGHPUT_EVIDENCE_ID]);
    expect(listConfirmedStoryEvidence(raw, second.id)).toHaveLength(1);
  });

  it('不存在的 Story 报错而不是静默成功', () => {
    const { api } = harness(raw);

    expect(() => api.remove('story-does-not-exist')).toThrow(StoryError);
  });
});

describe('Speech source 支持 story', () => {
  it('口述正文落在 speech_snippet 上，来源类型是 story、来源 id 是 Story 自己', async () => {
    const { api } = harness(raw);
    const story = await api.create(STORY_INPUT);

    const snippet = await api.createDelivery(story.id, 120);

    expect(snippet.sourceType).toBe('story');
    expect(snippet.sourceId).toBe(story.id);
    expect(snippet.tier).toBe('spoken');
    const row = raw
      .prepare(`SELECT source_type, source_id FROM speech_snippet WHERE id = ?`)
      .get(snippet.id) as { source_type: string; source_id: string };
    expect(row).toEqual({ source_type: 'story', source_id: story.id });
  });

  it('用户改写过的口述照常留在话术库里，元数据仍指回这一档', async () => {
    const { api } = harness(raw);
    const story = await api.create(STORY_INPUT);
    const snippet = await api.createDelivery(story.id, 30);

    raw
      .prepare(`UPDATE speech_snippet SET content_md = ?, is_user_edited = 1 WHERE id = ?`)
      .run('我自己改顺口的版本', snippet.id);

    const [delivery] = api.listDeliveries(story.id);
    expect(delivery.contentMd).toBe('我自己改顺口的版本');
    expect(delivery.isUserEdited).toBe(true);
    expect(delivery.durationSeconds).toBe(30);
  });
});
