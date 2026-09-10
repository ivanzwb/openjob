/**
 * Phase 0 兼容性闸门（共享层）。
 *
 * T01—T08 各自的测试证明自己那块是对的，但「插件外壳没有破坏现有软件工程
 * 流程」是一条跨越岗位包、组合器、排程和本机视图的整链结论，没有哪个单点
 * 测试会因为链子断在别处而失败。这里就守这条链：同一个插件化之前的战役，
 * 四种题型仍然组合得出 Prompt、有 ready repo 仍然排得出 readCode、禁用能力
 * 后既不排任务也不给权限、两端消费的是同一次解析结果。
 */
import { describe, expect, it } from 'vitest';
import { EXAM_FORMS } from '../enums';
import {
  REQUIRES_DESKTOP_REASON,
  collectPlannerContributions,
  legacyRuntimeDescriptor,
  type PlannerContext,
  type PlannerRepo,
} from '../planner/contributions';
import { composePrompt } from '../prompts/composer';
import { formatIdForLegacyExamForm } from './legacyRoleData';
import { softwareEngineeringRolePack } from './rolePacks/softwareEngineering';
import { SOURCE_REPOSITORY_CAPABILITY_ID } from './builtin/sourceRepository';
import { buildClientCapabilityView, capabilityMode, listBuiltInPlugins } from './clientView';
import {
  PHASE0_CAMPAIGN,
  PHASE0_READY_REPO_ID,
  PHASE0_READ_CODE_MINUTES,
  PHASE0_REPOS,
} from './__fixtures__/phase0Campaign';
import type { CampaignRuntimeDescriptor } from './types';

const CAMPAIGN_ID = PHASE0_CAMPAIGN.id;

function repos(): PlannerRepo[] {
  return PHASE0_REPOS.map((repo) => ({ id: repo.id, url: repo.url, status: repo.status }));
}

/** dayIndex 取奇数：readCode 隔天一次，偶数天本来就不排。 */
function context(overrides: Partial<PlannerContext> = {}): PlannerContext {
  return {
    platform: 'desktop',
    dayIndex: 1,
    dayCount: 7,
    budgetMinutes: PHASE0_CAMPAIGN.dailyMinutes,
    usedMinutes: 0,
    repos: repos(),
    ...overrides,
  };
}

function withCapabilityDisabled(
  descriptor: CampaignRuntimeDescriptor,
): CampaignRuntimeDescriptor {
  return {
    ...descriptor,
    capabilities: descriptor.capabilities.map((capability) =>
      capability.id === SOURCE_REPOSITORY_CAPABILITY_ID
        ? {
            id: capability.id,
            enabled: false as const,
            disabledReason: 'user-disabled: 本次战役不看源码',
          }
        : capability,
    ),
  };
}

describe('Phase 0 兼容性闸门', () => {
  it('工程 JD 的四种题型仍然各自组合得出 Prompt', () => {
    const runtime = legacyRuntimeDescriptor(CAMPAIGN_ID);
    const formatIds = EXAM_FORMS.map(formatIdForLegacyExamForm);
    expect(new Set(formatIds).size).toBe(EXAM_FORMS.length);

    for (const [index, examForm] of EXAM_FORMS.entries()) {
      const formatId = formatIds[index];
      const composed = composePrompt({
        runtime,
        rolePack: softwareEngineeringRolePack,
        slot: 'questionGeneration',
        formatId,
        jobContext: PHASE0_CAMPAIGN.jdRaw,
      });

      expect(composed.provenance.formatId, examForm).toBe(formatId);
      expect(composed.provenance.rolePack).toEqual(runtime.rolePack);
      expect(composed.provenance.configSnapshotHash).toBe(runtime.configSnapshotHash);
      // 题型是岗位包声明的，评分标准必须跟着来，否则四种题型只是名字不同
      expect(composed.provenance.rubricId, examForm).toBeDefined();
      expect(composed.sections[0]?.layer).toBe('corePolicy');
    }
  });

  it('有 ready repo 时仍然排得出 readCode', () => {
    const tasks = collectPlannerContributions(legacyRuntimeDescriptor(CAMPAIGN_ID), context());

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      kind: 'readCode',
      nodeId: null,
      repoId: PHASE0_READY_REPO_ID,
      estMinutes: PHASE0_READ_CODE_MINUTES,
      capabilityId: SOURCE_REPOSITORY_CAPABILITY_ID,
    });
    expect(tasks[0].client.executable).toBe(true);
  });

  it('只有未索引仓库时不排 readCode', () => {
    const pendingOnly = repos().filter((repo) => repo.status !== 'ready');
    const tasks = collectPlannerContributions(
      legacyRuntimeDescriptor(CAMPAIGN_ID),
      context({ repos: pendingOnly }),
    );

    expect(tasks).toEqual([]);
  });

  it('禁用 source-repository 后既不排任务，也不认这项能力', () => {
    const disabled = withCapabilityDisabled(legacyRuntimeDescriptor(CAMPAIGN_ID));

    expect(collectPlannerContributions(disabled, context())).toEqual([]);

    const view = buildClientCapabilityView({
      descriptor: disabled,
      platform: 'desktop',
      installed: listBuiltInPlugins(),
    });
    expect(capabilityMode(view, SOURCE_REPOSITORY_CAPABILITY_ID)).toBe('unsupported');
    expect(view.enabledCapabilityIds).not.toContain(SOURCE_REPOSITORY_CAPABILITY_ID);
  });

  it('手机把 readCode 标成需桌面完成，而不是少排一条', () => {
    const runtime = legacyRuntimeDescriptor(CAMPAIGN_ID);
    const desktop = collectPlannerContributions(runtime, context({ platform: 'desktop' }));
    const mobile = collectPlannerContributions(runtime, context({ platform: 'mobile' }));

    // 会落库的字段必须逐条相同，差异只允许出现在客户端视图里
    expect(mobile.map((task) => task.kind)).toEqual(desktop.map((task) => task.kind));
    expect(mobile.map((task) => task.repoId)).toEqual(desktop.map((task) => task.repoId));
    expect(mobile.map((task) => task.estMinutes)).toEqual(desktop.map((task) => task.estMinutes));

    expect(mobile[0].client).toMatchObject({
      platform: 'mobile',
      executable: false,
      blockedReason: REQUIRES_DESKTOP_REASON,
    });
  });

  it('本机降级只算视图，不改 descriptor', () => {
    const runtime = legacyRuntimeDescriptor(CAMPAIGN_ID);
    const before = structuredClone(runtime);

    const views = (['desktop', 'mobile'] as const).map((platform) =>
      buildClientCapabilityView({
        descriptor: runtime,
        platform,
        installed: listBuiltInPlugins(),
      }),
    );

    expect(runtime).toEqual(before);
    // 两端读的是同一次解析结果：谁自己重算过一遍，hash 就对不上了
    for (const view of views) {
      expect(view.configSnapshotHash).toBe(runtime.configSnapshotHash);
    }
    expect(views[0].readOnlyCapabilityIds).toEqual([]);
    expect(views[1].readOnlyCapabilityIds).toEqual([SOURCE_REPOSITORY_CAPABILITY_ID]);
  });
});
