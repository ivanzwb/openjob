/**
 * 插件任务的共享判定。
 *
 * 桌面和手机曾各自写一份 readCode 排程，改动一端就会漂移。这里守三件事：
 * 节奏与插件化之前逐条一致、未启用时不排、两端同一输入同一输出。
 */
import { describe, expect, it } from 'vitest';
import {
  REQUIRES_DESKTOP_REASON,
  collectPlannerContributions,
  pluginTaskClientView,
  type PlannedTask,
  type PlannerContext,
  type PlannerRepo,
} from './contributions';
import {
  CROSS_CLIENT_PLAN,
  crossClientPrePluginPlan,
  dailyBudget,
  prePluginPlan,
  type PrePluginPlanDay,
} from './__fixtures__/prePluginPlan';
import type { CampaignRuntimeDescriptor, ClientPlatform } from '../plugins/types';
import { installedCapabilitySuiteOnly } from '../plugins/__fixtures__/installed';
import { CORE_CAPABILITIES_PACK_ID } from '../plugins/capabilitySuite';
import { softwareEngineeringRolePack } from '@plugins/softwareEngineering';

const REPOS: PlannerRepo[] = [...CROSS_CLIENT_PLAN.repos];

function descriptor(
  overrides: Partial<CampaignRuntimeDescriptor> = {},
): CampaignRuntimeDescriptor {
  return { ...prePluginRuntimeDescriptor(CROSS_CLIENT_PLAN.campaignId), ...overrides };
}

function contextFor(
  day: PrePluginPlanDay,
  dayCount: number,
  dailyMinutes: number,
  platform: ClientPlatform = 'desktop',
  repos: PlannerRepo[] = REPOS,
): PlannerContext {
  return {
    platform,
    dayIndex: day.dayIndex,
    dayCount,
    budgetMinutes: dailyBudget(dailyMinutes),
    usedMinutes: day.baseMinutes,
    repos,
    installed: installedCapabilitySuiteOnly(),
    rolePack: softwareEngineeringRolePack,
  };
}

function payloads(tasks: PlannedTask[]): Array<Omit<PlannedTask, 'client'>> {
  return tasks.map(({ client: _client, ...rest }) => rest);
}

describe('collectPlannerContributions', () => {
  it('启用 source-repository 且有已索引仓库时，readCode 节奏与插件化之前逐条一致', () => {
    // 覆盖预算刚好装得下、装不下和完全排不进的几档
    for (const dailyMinutes of [40, 60, 90, 120, 180, 240]) {
      const days = prePluginPlan({
        today: CROSS_CLIENT_PLAN.today,
        interviewDate: CROSS_CLIENT_PLAN.interviewDate,
        dailyMinutes,
        nodes: CROSS_CLIENT_PLAN.nodes.map((node) => ({ ...node })),
        defaultRepoId: CROSS_CLIENT_PLAN.readyRepoId,
      });

      for (const day of days) {
        const tasks = collectPlannerContributions(
          descriptor(),
          contextFor(day, days.length, dailyMinutes),
        );

        expect(
          payloads(tasks).map(({ kind, nodeId, repoId, estMinutes }) => ({
            kind,
            nodeId,
            repoId,
            estMinutes,
          })),
          `${dailyMinutes} 分钟 / 第 ${day.dayIndex} 天`,
        ).toEqual(
          day.tasks
            .filter((task) => task.kind === 'readCode')
            .map(({ kind, nodeId, repoId, estMinutes }) => ({
              kind,
              nodeId,
              repoId,
              estMinutes,
            })),
        );
      }
    }
  });

  it('插件任务带上贡献者与能力来源，便于审计', () => {
    const days = crossClientPrePluginPlan();

    const tasks = collectPlannerContributions(
      descriptor(),
      contextFor(days[1]!, days.length, CROSS_CLIENT_PLAN.dailyMinutes),
    );

    expect(tasks).toEqual([
      {
        contributionId: 'se.read-code',
        // 实现由能力合编包承载：审计归属跟着走，历史 descriptor 仍 pin 旧 id 由归一化兜住
        capabilityId: CORE_CAPABILITIES_PACK_ID,
        kind: 'readCode',
        nodeId: null,
        repoId: 'repo-ready',
        estMinutes: 25,
        client: {
          platform: 'desktop',
          availability: 'full',
          executable: true,
          blockedReason: null,
        },
      },
    ]);
  });

  it('未启用 source-repository 时不生成 readCode', () => {
    const days = crossClientPrePluginPlan();
    const disabled = descriptor({
      capabilities: [
        {
          id: 'source-repository',
          enabled: false,
          disabledReason: 'plugin-not-found: 插件未安装：source-repository',
        },
      ],
    });
    const absent = descriptor({ capabilities: [] });

    for (const day of days) {
      const context = contextFor(day, days.length, CROSS_CLIENT_PLAN.dailyMinutes);
      expect(collectPlannerContributions(disabled, context)).toEqual([]);
      expect(collectPlannerContributions(absent, context)).toEqual([]);
    }
  });

  it('非工程岗位包即使启用了同一能力也不排 readCode', () => {
    const days = crossClientPrePluginPlan();
    const productManager = descriptor({
      rolePack: { id: 'product-manager', version: '1.0.0' },
    });

    for (const day of days) {
      expect(
        collectPlannerContributions(
          productManager,
          contextFor(day, days.length, CROSS_CLIENT_PLAN.dailyMinutes),
        ),
      ).toEqual([]);
    }
  });

  it('descriptor pin 的版本不在本机时，按已装同 id 包继续排（插件装上即功能一致）', () => {
    const days = crossClientPrePluginPlan();
    const pinnedToMissing = descriptor({
      capabilities: [{ id: 'source-repository', version: '9.9.9', enabled: true }],
    });

    const tasks = collectPlannerContributions(
      pinnedToMissing,
      contextFor(days[1]!, days.length, CROSS_CLIENT_PLAN.dailyMinutes),
    );
    // 不再因 pin 版本缺失停排：readCode 照常生成且在桌面可执行；
    // 历史可解释性由 attempt 自带的 rubric/prompt 版本记录承担
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks[0]).toMatchObject({ kind: 'readCode', client: { executable: true } });
  });

  it('没有已索引仓库时不生成 readCode', () => {
    const days = crossClientPrePluginPlan();

    expect(
      collectPlannerContributions(
        descriptor(),
        contextFor(days[1]!, days.length, CROSS_CLIENT_PLAN.dailyMinutes, 'desktop', [
          { id: 'repo-cloning', url: 'https://example.com/other', status: 'cloning' },
        ]),
      ),
    ).toEqual([]);
  });

  it('多个已索引仓库时按 url 定序，两端选到同一个', () => {
    const days = crossClientPrePluginPlan();
    const shuffled: PlannerRepo[] = [
      { id: 'repo-z', url: 'https://example.com/zeta', status: 'ready' },
      { id: 'repo-a', url: 'https://example.com/alpha', status: 'ready' },
    ];

    const desktop = collectPlannerContributions(
      descriptor(),
      contextFor(days[1]!, days.length, CROSS_CLIENT_PLAN.dailyMinutes, 'desktop', shuffled),
    );
    const mobile = collectPlannerContributions(
      descriptor(),
      contextFor(days[1]!, days.length, CROSS_CLIENT_PLAN.dailyMinutes, 'mobile', [
        ...shuffled,
      ].reverse()),
    );

    expect(desktop[0]?.repoId).toBe('repo-a');
    expect(mobile[0]?.repoId).toBe('repo-a');
  });

  it('两端相同输入产生逐条相同的插件任务，只有本机可执行状态不同', () => {
    const days = crossClientPrePluginPlan();

    for (const day of days) {
      const desktop = collectPlannerContributions(
        descriptor(),
        contextFor(day, days.length, CROSS_CLIENT_PLAN.dailyMinutes, 'desktop'),
      );
      const mobile = collectPlannerContributions(
        descriptor(),
        contextFor(day, days.length, CROSS_CLIENT_PLAN.dailyMinutes, 'mobile'),
      );

      expect(payloads(mobile)).toEqual(payloads(desktop));
      for (const task of mobile) {
        // 手机排出同一条任务，但显示为需桌面完成，而不是静默丢弃
        expect(task.client).toEqual({
          platform: 'mobile',
          availability: 'view-only',
          executable: false,
          blockedReason: REQUIRES_DESKTOP_REASON,
        });
      }
    }
  });
});

/**
 * `null` 表示这个 Campaign 还没选岗位。
 *
 * 之前这种情况一律拿工程岗兜底，导致「没选岗位」和「选了工程岗」排出同一份计划：
 * 用户新建战役就看到一堆源码任务，而岗位表单里空着，看不出是谁决定的。
 */
describe('还没选岗位的 Campaign', () => {
  it('不排任何插件任务', () => {
    const days = prePluginPlan({
      today: CROSS_CLIENT_PLAN.today,
      interviewDate: CROSS_CLIENT_PLAN.interviewDate,
      dailyMinutes: CROSS_CLIENT_PLAN.dailyMinutes,
      nodes: CROSS_CLIENT_PLAN.nodes.map((node) => ({ ...node })),
      defaultRepoId: CROSS_CLIENT_PLAN.readyRepoId,
    });

    for (const day of days) {
      expect(
        collectPlannerContributions(null, contextFor(day, days.length, CROSS_CLIENT_PLAN.dailyMinutes)),
        `第 ${day.dayIndex} 天`,
      ).toEqual([]);
    }
  });

  it('已落库任务也拿不到插件降级状态', () => {
    for (const platform of ['desktop', 'mobile'] as const) {
      expect(pluginTaskClientView(null, 'readCode', platform, [], null)).toBeNull();
    }
  });
});

describe('pluginTaskClientView', () => {
  it('已落库的 readCode 在手机上标记需桌面完成', () => {
    expect(
      pluginTaskClientView(descriptor(), 'readCode', 'mobile', installedCapabilitySuiteOnly(), softwareEngineeringRolePack),
    ).toEqual({
      platform: 'mobile',
      availability: 'view-only',
      executable: false,
      blockedReason: REQUIRES_DESKTOP_REASON,
    });
  });

  it('桌面上同一条任务可以直接执行', () => {
    expect(
      pluginTaskClientView(descriptor(), 'readCode', 'desktop', installedCapabilitySuiteOnly(), softwareEngineeringRolePack),
    ).toEqual({
      platform: 'desktop',
      availability: 'full',
      executable: true,
      blockedReason: null,
    });
  });

  it('基础任务不归插件所有，不带降级状态', () => {
    for (const kind of ['learn', 'drill', 'review', 'fallbackScript'] as const) {
      expect(pluginTaskClientView(descriptor(), kind, 'mobile', installedCapabilitySuiteOnly(), softwareEngineeringRolePack)).toBeNull();
    }
  });

  it('能力被禁用后已落库的任务也不再声称可执行', () => {
    const disabled = descriptor({
      capabilities: [
        { id: 'source-repository', enabled: false, disabledReason: '用户已关闭源码能力' },
      ],
    });

    expect(
      pluginTaskClientView(disabled, 'readCode', 'desktop', installedCapabilitySuiteOnly(), softwareEngineeringRolePack),
    ).toBeNull();
  });
});
import { prePluginRuntimeDescriptor } from '../plugins/__fixtures__/prePluginDescriptor';