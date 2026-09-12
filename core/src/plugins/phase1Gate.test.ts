/**
 * Phase 1 通用核心闸门（共享层）。
 *
 * Phase 0 守的是「插件外壳没有破坏工程流程」，这里守的是下一条整链结论：同一套
 * 通用核心换上首个非工程岗位包之后，诊断、组合、排程仍然整条跑得通，并且不把
 * 工程口吻带过去；与此同时工程岗位一条都不少。
 *
 * 两个岗位包在同一个用例文件里对照跑，是因为「不污染」和「无回归」是同一枚硬币：
 * 只测产品会漏掉工程被顺手改坏，只测工程则根本发现不了产品在走工程兜底路径。
 */
import { describe, expect, it } from 'vitest';
import { diagnoseCompetencies } from '../competency/diagnose';
import {
  collectPlannerContributions,
  legacyRuntimeDescriptor,
  type PlannerContext,
  type PlannerRepo,
} from '../planner/contributions';
import { composePrompt } from '../prompts/composer';
import type { PromptSlot } from '../prompts/registry';
import { DISTRIBUTED_ROLE_PACKS } from '@plugins';
import { synthesizeSuiteFromRolePack } from './capabilitySuite';
import {
  PRODUCT_MANAGER_FORMAT_IDS,
  PRODUCT_MANAGER_ROLE_PACK_ID,
  productManagerRolePack,
} from '@plugins/productManager';
import { softwareEngineeringRolePack } from '@plugins/softwareEngineering';
import { CORE_CAPABILITIES_PACK_ID } from './capabilitySuite';
import { buildClientCapabilityView } from './clientView';
import { installedWith } from './__fixtures__/installed';
import { BuiltInPluginRegistry } from './registry';
import { DeterministicRuntimeResolver } from './resolver';
import { PHASE0_CAMPAIGN, PHASE0_REPOS } from './__fixtures__/phase0Campaign';
import {
  PHASE1_CAMPAIGN,
  PHASE1_ENGINEERING_MARKERS,
  PHASE1_JD_REQUIREMENTS,
} from './__fixtures__/phase1Campaign';
import type { CampaignRuntimeDescriptor } from './types';

const PM_FORMAT_IDS = Object.values(PRODUCT_MANAGER_FORMAT_IDS);


/**
 * 走真实 resolver 而不是手写描述符：组合器要求岗位包版本与 descriptor 逐字一致，
 * 手写的假绑定过不了那一关，也就测不到真实调用路径。
 */
function phase1Runtime(): CampaignRuntimeDescriptor {
  const registry = new BuiltInPluginRegistry();
  DISTRIBUTED_ROLE_PACKS.forEach((pack) => registry.register(pack));
  // 内置清单已清空：能力由合编包承载，测试里的「已安装」与生产一样走注册表
  const suite = synthesizeSuiteFromRolePack(softwareEngineeringRolePack);
  if (suite) registry.registerCapability(suite);

  const resolved = new DeterministicRuntimeResolver(registry).resolve({
    coreVersion: '1.0.0',
    schemaVersion: 23,
    rolePackId: PRODUCT_MANAGER_ROLE_PACK_ID,
    capabilityIds: [],
  });
  if (!resolved.ok) throw new Error(`产品岗位运行时解析失败：${resolved.error.message}`);

  return { ...resolved.descriptor, campaignId: PHASE1_CAMPAIGN.id, resolvedAt: 0 };
}


function repos(): PlannerRepo[] {
  return PHASE0_REPOS.map((repo) => ({ id: repo.id, url: repo.url, status: repo.status }));
}

/** dayIndex 取奇数：readCode 隔天一次，偶数天本来就不排，测不出区别。 */
function context(overrides: Partial<PlannerContext> = {}): PlannerContext {
  return {
    platform: 'desktop',
    dayIndex: 1,
    dayCount: 7,
    budgetMinutes: PHASE0_CAMPAIGN.dailyMinutes,
    usedMinutes: 0,
    repos: repos(),
    installed: installedWith(productManagerRolePack, softwareEngineeringRolePack),
    ...overrides,
  };
}

describe('Phase 1 通用核心闸门', () => {
  const runtime = phase1Runtime();

  it('产品战役的三种题型都组合得出出题与评分 Prompt', () => {
    for (const formatId of PM_FORMAT_IDS) {
      for (const slot of ['questionGeneration', 'scoring'] as const) {
        const composed = composePrompt({
          runtime,
          rolePack: productManagerRolePack,
          slot,
          formatId,
          jobContext: PHASE1_CAMPAIGN.jdRaw,
        });

        expect(composed.provenance.formatId, formatId).toBe(formatId);
        expect(composed.provenance.rolePack).toEqual(runtime.rolePack);
        expect(composed.provenance.configSnapshotHash).toBe(runtime.configSnapshotHash);
        // 题型是岗位包声明的，评分标准必须跟着来，否则三种题型只是名字不同
        expect(composed.provenance.rubricId, formatId).toBeDefined();
        expect(composed.sections[0]?.layer).toBe('corePolicy');
      }
    }
  });

  it('诊断与复盘两端也各自组合得出，整条链不缺环', () => {
    const evidence = [
      {
        id: 'phase1-ev-1',
        kind: 'experience',
        statement: '主导会员续费流程改版，续费率从 18% 提升到 24%。',
        userConfirmed: true,
      },
    ];

    for (const slot of ['diagnosis', 'explanation', 'debrief'] as PromptSlot[]) {
      const composed = composePrompt({
        runtime,
        rolePack: productManagerRolePack,
        slot,
        evidence,
      });

      expect(composed.provenance.promptSlot).toBe(slot);
      expect(composed.sections[0]?.layer).toBe('corePolicy');
    }
  });

  /**
   * T14 的 contract 用例扫的是岗位包声明，这里扫的是真正送进模型的那份文本。
   * 声明干净但组合时被别的层追加进工程口吻，用户拿到的仍然是一份带编码要求的
   * 产品案例题——那种情况只有在这一层才看得见。
   */
  it('产品战役组合出来的 Prompt 里没有任何工程口吻', () => {
    const composedTexts = PM_FORMAT_IDS.flatMap((formatId) =>
      (['questionGeneration', 'scoring', 'answerCoaching'] as const).map(
        (slot) =>
          composePrompt({
            runtime,
            rolePack: productManagerRolePack,
            slot,
            formatId,
            jobContext: PHASE1_CAMPAIGN.jdRaw,
            evidence: [
              {
                id: 'phase1-ev-1',
                kind: 'experience',
                statement: '主导会员续费流程改版，续费率从 18% 提升到 24%。',
                userConfirmed: true,
              },
            ],
          }).systemPrompt,
      ),
    );

    expect(composedTexts.length).toBe(PM_FORMAT_IDS.length * 3);
    for (const text of composedTexts) {
      const lowered = text.toLocaleLowerCase();
      for (const marker of PHASE1_ENGINEERING_MARKERS) {
        expect(lowered, `工程口吻泄漏：${marker}`).not.toContain(marker.toLocaleLowerCase());
      }
    }
  });

  it('产品 JD 的每条要求都被产品能力接住，且不长出任何工程能力', async () => {
    const diagnosis = await diagnoseCompetencies({
      rolePack: productManagerRolePack,
      jd: {
        roleTitle: PHASE1_CAMPAIGN.roleTitle,
        seniority: null,
        requirements: [...PHASE1_JD_REQUIREMENTS],
      },
      evidence: [],
    });

    const ids = diagnosis.competencies.map((item) => item.templateId);
    expect(ids.every((id) => id.startsWith('pm.'))).toBe(true);
    expect(ids).toHaveLength(productManagerRolePack.competencyTemplates.length);
    expect(diagnosis.rolePackId).toBe(PRODUCT_MANAGER_ROLE_PACK_ID);
    expect(diagnosis.uncoveredRequirements).toEqual([]);
  });

  /**
   * 「计划」这一腿在产品岗位上落在准备成本里：每条能力要花多少时间，取的是岗位包
   * 自己的任务模板之和。产品包一条任务都不挂 capabilityId，所以没装任何能力插件
   * 的用户也应该拿到一份完整计划——退到全岗位共用的兜底常数就说明模板没被读到。
   */
  it('产品战役的准备成本来自产品自己的任务模板，且不依赖任何插件', async () => {
    const budget = productManagerRolePack.taskTemplates
      .filter((task) => task.capabilityId === undefined)
      .reduce((sum, task) => sum + task.defaultMinutes, 0);
    expect(budget).toBeGreaterThan(0);

    const diagnosis = await diagnoseCompetencies({
      rolePack: productManagerRolePack,
      jd: {
        roleTitle: PHASE1_CAMPAIGN.roleTitle,
        seniority: null,
        requirements: [...PHASE1_JD_REQUIREMENTS],
      },
      evidence: [],
    });

    for (const competency of diagnosis.competencies) {
      expect(competency.estMinutes, competency.templateId).toBeGreaterThan(0);
      expect(competency.estMinutes, competency.templateId).toBeLessThanOrEqual(budget);
    }
    // 排序是计划的产出之一：优先级降序错了，用户第一天就在练最不该练的那条
    const scores = diagnosis.competencies.map((competency) => competency.priority.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('产品战役即使装着已索引仓库也不排源码任务', () => {
    // 仓库是 Campaign 层面的既有数据，换岗位包不会把它删掉，只应该不再被排进计划
    expect(collectPlannerContributions(runtime, context())).toEqual([]);
    expect(repos().some((repo) => repo.status === 'ready')).toBe(true);
  });

  it('工程战役在同一份核心下没有回归，仍然排得出源码任务', () => {
    const engineering = legacyRuntimeDescriptor(PHASE0_CAMPAIGN.id);
    const tasks = collectPlannerContributions(engineering, context());

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      kind: 'readCode',
      // 贡献的实现由合编包承载：旧 descriptor 的退役 id 归一化后按新 id 归属
      capabilityId: CORE_CAPABILITIES_PACK_ID,
    });
    expect(tasks[0].client.executable).toBe(true);
  });

  it('两个岗位包共用同一套内置插件，差异只落在各自的声明上', () => {
    const engineering = legacyRuntimeDescriptor(PHASE0_CAMPAIGN.id);

    expect(runtime.coreVersion).toBe(engineering.coreVersion);
    // 同一个核心解析出两份不同配置：hash 相同就说明岗位包没真正进入快照
    expect(runtime.configSnapshotHash).not.toBe(engineering.configSnapshotHash);
    expect(runtime.rolePack.id).toBe(PRODUCT_MANAGER_ROLE_PACK_ID);
    expect(engineering.rolePack.id).toBe(softwareEngineeringRolePack.manifest.id);
  });

  it('产品战役在两端得到同一次解析结果，只有本机模式可能不同', () => {
    const views = (['desktop', 'mobile'] as const).map((platform) =>
      buildClientCapabilityView({
        descriptor: runtime,
        platform,
        installed: installedWith(productManagerRolePack),
      }),
    );

    for (const view of views) {
      expect(view.configSnapshotHash).toBe(runtime.configSnapshotHash);
      expect(view.rolePack.mode).toBe('full');
      // 能力插件的可用性是本机的事，不该把整个战役判成降级只读
      expect(view.rolePack.reason).toBeNull();
    }

    // 两端拿到的能力集合逐字相同，差异只落在 mode 上
    expect(views[0].capabilities.map((item) => item.id)).toEqual(
      views[1].capabilities.map((item) => item.id),
    );
    // analytics-case 是产品岗的可选依赖，装上了就自动生效；手机端没有表格读入，只读
    // analytics-case 已并入能力合编包：PM 包的可选依赖装上即生效，手机只读
    expect(views[0].enabledCapabilityIds).toContain(CORE_CAPABILITIES_PACK_ID);
    expect(views[1].enabledCapabilityIds).not.toContain(CORE_CAPABILITIES_PACK_ID);
    expect(views[1].readOnlyCapabilityIds).toEqual([CORE_CAPABILITIES_PACK_ID]);
  });
});
