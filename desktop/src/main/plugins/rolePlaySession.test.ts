/**
 * 客户对话会话服务：编排层的真路径。
 *
 * interactionRuntime.test.ts 证明的是生命周期规则本身，这里换一层——真迁移建库、
 * 真运行时描述符、真组合器，只有模型是替身。要证明的是编排没有把那些规则绕过去：
 * 岗位包与题型确实按 capabilityId 关联、拒绝确实以返回值出现、快照确实足以续练。
 */
import type { Database } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  SALES_CUSTOMER_SUCCESS_FORMAT_IDS,
  SALES_CUSTOMER_SUCCESS_ROLE_PACK_ID,
} from '@plugins/salesCustomerSuccess';
import { SOFTWARE_ENGINEERING_ROLE_PACK_ID } from '@plugins/softwareEngineering';
import { ROLE_PLAY_SCENARIOS } from '@plugins/salesCustomerSuccess/capabilities';
import type { ComposedPrompt } from '@core/prompts/composer';
import { newLegacyDb } from '../db/__fixtures__/legacyDb';
import { installRolePacks } from './__fixtures__/installedPlugins';
import { setCampaignRoleProfile } from './runtime';
import { restoreRolePlayState } from './interactionRuntime';
import {
  RolePlayError,
  createRolePlaySessionService,
  type RolePlaySessionService,
} from './rolePlaySession';

const CAMPAIGN_ID = 'campaign-sales-1';
const SCENARIO = ROLE_PLAY_SCENARIOS[0];

interface Call {
  slot: string;
  promptId: string;
  systemPrompt: string;
  user: string;
}

interface Harness {
  raw: Database;
  service: RolePlaySessionService;
  calls: Call[];
}

function newSalesDb(rolePackId: string = SALES_CUSTOMER_SUCCESS_ROLE_PACK_ID): Database {
  // 岗位包由用户安装，绑定之前先装上
  installRolePacks();
  const raw = newLegacyDb();

  raw
    .prepare(
      `INSERT INTO campaign (id, company, role_title, jd_raw, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'planning', 1, 1)`,
    )
    .run(
      CAMPAIGN_ID,
      '示例云服务',
      '企业客户成功经理',
      '负责重点客户续约与增购，主导季度业务复盘，推动跨部门解决客户问题。',
    );

  setCampaignRoleProfile(
    raw,
    {
      campaignId: CAMPAIGN_ID,
      roleFamily: rolePackId === SALES_CUSTOMER_SUCCESS_ROLE_PACK_ID ? 'sales' : 'engineering',
      rolePackId,
    },
    { now: () => 1000 },
  );

  return raw;
}

function harness(options: { replies?: string[]; rolePackId?: string } = {}): Harness {
  const raw = newSalesDb(options.rolePackId);
  const calls: Call[] = [];
  const replies = [...(options.replies ?? ['那你说说，具体怎么保证这次不一样？'])];

  let seq = 0;
  const service = createRolePlaySessionService({
    raw,
    now: () => 1_700_000_000_000 + seq * 1000,
    newId: () => `id-${++seq}`,
    completeJson: async <T>(request: {
      prompt: ComposedPrompt;
      user: string;
    }): Promise<T> => {
      calls.push({
        slot: request.prompt.provenance.promptSlot,
        promptId: request.prompt.provenance.promptId,
        systemPrompt: request.prompt.systemPrompt,
        user: request.user,
      });
      const next = replies.shift();
      if (next === undefined) throw new Error('预置回复用尽');
      return { reply: next } as T;
    },
  });

  return { raw, service, calls };
}

describe('开始对练', () => {
  it('渲染视图可用，开场白来自场景声明且未调用模型', async () => {
    const { service, calls } = harness();
    const session = await service.start({ campaignId: CAMPAIGN_ID, microphoneAvailable: true });

    expect(session.view.renderable).toBe(true);
    expect(session.view.mode).toBe('full');
    expect(session.status).toBe('awaiting-candidate');
    expect(session.terminal).toBe(false);
    expect(session.values.transcript).toHaveLength(1);
    expect(session.values.transcript[0]).toMatchObject({
      speaker: 'customer',
      text: SCENARIO.opening,
      intent: null,
    });
    // 开场不依赖模型：模型完全不可用时也能开局
    expect(calls).toHaveLength(0);
  });

  it('字段取值与 inputSchema 的字段一一对应', async () => {
    const { service } = harness();
    const session = await service.start({ campaignId: CAMPAIGN_ID, microphoneAvailable: true });

    expect(session.view.fields.map((field) => field.id)).toEqual([
      'persona',
      'scenario',
      'transcript',
      'remaining-time',
      'reply',
      'intent',
    ]);
    expect(session.values.persona).toEqual(SCENARIO.persona);
    expect(session.values.scenario).toBe(SCENARIO.brief);
    expect(session.values.remainingSeconds).toBeGreaterThan(0);
  });

  it('麦克风不可用时仍可渲染，只是改为文字作答', async () => {
    const { service } = harness();
    const session = await service.start({ campaignId: CAMPAIGN_ID, microphoneAvailable: false });

    expect(session.view.renderable).toBe(true);
    expect(session.voiceEnabled).toBe(false);
    const reply = session.view.fields.find((field) => field.id === 'reply');
    expect(reply?.kind === 'reply' ? reply.voiceNotice : null).toContain('文字作答');
  });

  it('岗位包没有依赖 role-play 的题型时明确报错', async () => {
    const { service } = harness({ rolePackId: SOFTWARE_ENGINEERING_ROLE_PACK_ID });

    await expect(
      service.start({ campaignId: CAMPAIGN_ID, microphoneAvailable: true }),
    ).rejects.toBeInstanceOf(RolePlayError);
  });

  it('指定了不存在的场景时报错，不静默换一个', async () => {
    const { service } = harness();

    await expect(
      service.start({
        campaignId: CAMPAIGN_ID,
        scenarioId: 'no-such-scenario',
        microphoneAvailable: true,
      }),
    ).rejects.toMatchObject({ code: 'scenario-unknown' });
  });
});

describe('推进一轮对话', () => {
  it('客户台词用岗位包自己的 role-play 题型组合提示词', async () => {
    const { service, calls } = harness();
    const started = await service.start({
      campaignId: CAMPAIGN_ID,
      microphoneAvailable: true,
    });

    const next = await service.submitTurn({
      campaignId: CAMPAIGN_ID,
      snapshot: started.snapshot,
      reply: '我先确认一下，你最在意的是内部问责还是这次的价格？',
      intent: 'discover',
      microphoneAvailable: true,
    });

    expect(next.rejection).toBeNull();
    expect(next.values.transcript.map((turn) => turn.speaker)).toEqual([
      'customer',
      'candidate',
      'customer',
    ]);
    expect(next.values.transcript[2].text).toBe('那你说说，具体怎么保证这次不一样？');
    expect(next.values.transcript[1].intent).toBe('discover');

    expect(calls).toHaveLength(1);
    expect(calls[0].slot).toBe('questionGeneration');
    // 用的是销售包声明的对话题型，不是随便一个题型
    expect(calls[0].promptId).toContain(SALES_CUSTOMER_SUCCESS_FORMAT_IDS.customerRolePlay);
    // 人设、场景和对话记录都进了请求，模型才接得住这位客户
    expect(calls[0].user).toContain(SCENARIO.persona[0].value);
    expect(calls[0].user).toContain(SCENARIO.brief);
    expect(calls[0].user).toContain('候选人：');
  });

  it('客户台词的提示词里没有工程侧正文', async () => {
    const { service, calls } = harness();
    const started = await service.start({
      campaignId: CAMPAIGN_ID,
      microphoneAvailable: true,
    });
    await service.submitTurn({
      campaignId: CAMPAIGN_ID,
      snapshot: started.snapshot,
      reply: '我理解你的压力。',
      microphoneAvailable: true,
    });

    const lowered = calls[0].systemPrompt.toLocaleLowerCase();
    for (const marker of ['系统设计', '吞吐', 'qps', '算法', '代码', 'readcode']) {
      expect(lowered).not.toContain(marker.toLocaleLowerCase());
    }
  });

  /** 拒绝是返回值而不是异常：一次误点不该让整轮对练崩掉。 */
  it('空作答被拒时原状退回，且不调用模型', async () => {
    const { service, calls } = harness();
    const started = await service.start({
      campaignId: CAMPAIGN_ID,
      microphoneAvailable: true,
    });

    const rejected = await service.submitTurn({
      campaignId: CAMPAIGN_ID,
      snapshot: started.snapshot,
      reply: '   ',
      microphoneAvailable: true,
    });

    expect(rejected.rejection).toMatchObject({ code: 'invalid-result' });
    expect(rejected.values.transcript).toHaveLength(1);
    expect(rejected.status).toBe('awaiting-candidate');
    expect(calls).toHaveLength(0);
  });

  it('未渲染过的意图取值被拒', async () => {
    const { service } = harness();
    const started = await service.start({
      campaignId: CAMPAIGN_ID,
      microphoneAvailable: true,
    });

    const rejected = await service.submitTurn({
      campaignId: CAMPAIGN_ID,
      snapshot: started.snapshot,
      reply: '我明白。',
      intent: 'whatever',
      microphoneAvailable: true,
    });

    expect(rejected.rejection?.detail).toContain('不是已渲染的选项');
  });

  it('模型崩溃时候选人那轮不丢，会话仍可继续', async () => {
    const { service } = harness({ replies: [] });
    const started = await service.start({
      campaignId: CAMPAIGN_ID,
      microphoneAvailable: true,
    });

    const next = await service.submitTurn({
      campaignId: CAMPAIGN_ID,
      snapshot: started.snapshot,
      reply: '这次我们把补偿写进合同。',
      microphoneAvailable: true,
    });

    expect(next.terminal).toBe(false);
    expect(next.status).toBe('awaiting-candidate');
    expect(next.values.transcript).toHaveLength(2);
  });

  it('快照损坏时明确报错，不猜着往下跑', async () => {
    const { service } = harness();

    await expect(
      service.submitTurn({
        campaignId: CAMPAIGN_ID,
        snapshot: '{oops',
        reply: '你好',
        microphoneAvailable: true,
      }),
    ).rejects.toMatchObject({ code: 'snapshot-unusable' });
  });
});

describe('结束与续练', () => {
  it('中止后记录留存并进入终态', async () => {
    const { service } = harness();
    const started = await service.start({
      campaignId: CAMPAIGN_ID,
      microphoneAvailable: true,
    });

    const ended = service.end({
      campaignId: CAMPAIGN_ID,
      snapshot: started.snapshot,
      action: 'cancel',
      microphoneAvailable: true,
    });

    expect(ended.status).toBe('cancelled');
    expect(ended.terminal).toBe(true);
    expect(ended.values.transcript).toHaveLength(1);
    expect(ended.terminalDetail).toContain('对话记录已保留');
    expect(ended.values.remainingSeconds).toBe(0);
  });

  it('交卷进入 completed 终态', async () => {
    const { service } = harness();
    const started = await service.start({
      campaignId: CAMPAIGN_ID,
      microphoneAvailable: true,
    });

    expect(
      service.end({
        campaignId: CAMPAIGN_ID,
        snapshot: started.snapshot,
        action: 'complete',
        microphoneAvailable: true,
      }).status,
    ).toBe('completed');
  });

  /**
   * 服务无状态，所以「换一个服务实例继续」与「重启应用后继续」是同一件事。
   * 这一条就是「角色状态可恢复」在编排层的证据。
   */
  it('换一个服务实例也能凭快照接着练', async () => {
    const first = harness();
    const started = await first.service.start({
      campaignId: CAMPAIGN_ID,
      microphoneAvailable: true,
    });
    const midway = await first.service.submitTurn({
      campaignId: CAMPAIGN_ID,
      snapshot: started.snapshot,
      reply: '先把故障时间线过一遍。',
      microphoneAvailable: true,
    });

    // 另起一个服务（另一个库、另一次进程），只带着快照过来
    const second = harness({ replies: ['那时间线之外的赔偿怎么算？'] });
    const resumed = await second.service.submitTurn({
      campaignId: CAMPAIGN_ID,
      snapshot: midway.snapshot,
      reply: '赔偿按 SLA 条款走。',
      microphoneAvailable: true,
    });

    expect(resumed.rejection).toBeNull();
    expect(resumed.values.transcript.map((turn) => turn.speaker)).toEqual([
      'customer',
      'candidate',
      'customer',
      'candidate',
      'customer',
    ]);
    expect(resumed.values.transcript[4].text).toBe('那时间线之外的赔偿怎么算？');
  });

  it('返回的快照本身可被运行时还原', async () => {
    const { service } = harness();
    const started = await service.start({
      campaignId: CAMPAIGN_ID,
      microphoneAvailable: true,
    });

    const restored = restoreRolePlayState(started.snapshot);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.state.scenarioId).toBe(SCENARIO.id);
  });
});
