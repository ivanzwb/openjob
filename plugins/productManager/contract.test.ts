import { describe, expect, it } from 'vitest';
import { composePrompt } from '@core/prompts/composer';
import type { PromptEvidence, PromptRuntimeSnapshot } from '@core/prompts/composer';
import type { PromptSlot } from '@core/prompts/registry';
import { validateRolePack } from '@core/plugins/contracts';
import type { CampaignRuntimeDescriptor } from '@core/plugins/types';
import {
  activatePluginRuntime,
  createEventHub,
  type PluginRuntimeModule,
  type PluginRuntimeServices,
} from '@core/plugins/pluginRuntime/host';
import { activate as desktopActivate } from './desktop/main';
import { activate as mobileActivate } from './mobile/main';
import {
  PRODUCT_MANAGER_FORMAT_IDS,
  PRODUCT_MANAGER_OPTIONAL_CAPABILITY_IDS,
  PRODUCT_MANAGER_ROLE_PACK_ID,
  PRODUCT_MANAGER_ROLE_PACK_VERSION,
  productManagerRolePack,
} from './index';

const formatIds = Object.values(PRODUCT_MANAGER_FORMAT_IDS);

/** 可选能力都没装：这就是 T14 要求的最小可用环境。 */
const RUNTIME: PromptRuntimeSnapshot = {
  coreVersion: '1.0.0',
  rolePack: {
    id: PRODUCT_MANAGER_ROLE_PACK_ID,
    version: PRODUCT_MANAGER_ROLE_PACK_VERSION,
  },
  capabilities: Object.values(PRODUCT_MANAGER_OPTIONAL_CAPABILITY_IDS).map((id) => ({
    id,
    enabled: false as const,
    disabledReason: `plugin-not-found: 插件未安装：${id}`,
  })),
  configSnapshotHash: 'pm-contract-test',
};

const EVIDENCE: PromptEvidence[] = [
  {
    id: 'ev-1',
    kind: 'experience',
    statement: '负责会员续费流程改版，上线后续费率从 18% 提升到 24%。',
    userConfirmed: true,
  },
];

/** 最小可用运行时服务：案例页只注册页面与桥方法，不碰宿主任何服务。 */
function runtimeServices(): PluginRuntimeServices {
  return {
    campaign: { getDescriptor: async () => null as CampaignRuntimeDescriptor | null },
    storage: {
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined,
    },
    data: {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
      list: async () => [],
      count: async () => 0,
    },
  };
}

/** 用最小运行时激活某个端入口（desktop/main.ts / mobile/main.ts），拿到页面与桥方法声明。 */
function activateEntry(activate: PluginRuntimeModule['activate']) {
  return activatePluginRuntime({
    pluginId: PRODUCT_MANAGER_ROLE_PACK_ID,
    version: PRODUCT_MANAGER_ROLE_PACK_VERSION,
    module: { activate },
    services: runtimeServices(),
    hub: createEventHub(),
  });
}

function compose(slot: PromptSlot, formatId?: string): ReturnType<typeof composePrompt> {
  return composePrompt({
    runtime: RUNTIME,
    rolePack: productManagerRolePack,
    slot,
    formatId,
    evidence: EVIDENCE,
  });
}

describe('productManagerRolePack contract', () => {
  it('通过 T01 的 RolePack 校验', () => {
    expect(validateRolePack(productManagerRolePack)).toEqual([]);
  });

  it('执行权限全部来自内嵌能力，「案例训练」页随包分发，能力插件只作为可选依赖', () => {
    expect(productManagerRolePack.manifest).toMatchObject({
      id: 'product-manager',
      version: '1.0.0',
      type: 'role-pack',
      compatibility: { core: '^1.0.0', schema: 23 },
      // 解析器要 artifact:read，案例页的 LLM 流程要 llm:complete——两项都由内嵌的
      // analytics-case 声明贡献，manifest 只是它们的并集（contracts 校验）
      permissions: ['artifact:read', 'llm:complete'],
      // 「案例训练」页属于本包：桌面与移动各一份实现
      main: 'desktop/main.js',
      mobile: 'mobile/main.js',
      api: '^1.0',
      // 案例（题目 / 作答 / 评分）存在本包声明的集合里，内容对宿主不透明
      dataCollections: [{ name: 'cases', schemaVersion: 1 }],
      dependencies: [
        { id: 'portfolio-review', version: '^1.0.0', optional: true },
      ],
    });
    // 可选依赖必须真的可选：写成必需依赖时没装插件的用户连岗位都选不了
    for (const dependency of productManagerRolePack.manifest.dependencies ?? []) {
      expect(dependency.optional, `${dependency.id} 必须是可选依赖`).toBe(true);
    }
  });

  it('「案例训练」页随包分发：两端入口各注册同一个页面 id，deactivate 后撤干净', () => {
    // manifest.main / manifest.mobile 指向的两份入口各自注册「案例训练」页，页面 id
    // 归本包所有——宿主侧完整 id 由运行时拼成 `<pluginId>:case-practice`
    for (const activate of [desktopActivate, mobileActivate]) {
      const active = activateEntry(activate);
      expect(active.pages).toEqual([
        {
          pluginId: PRODUCT_MANAGER_ROLE_PACK_ID,
          fullId: `${PRODUCT_MANAGER_ROLE_PACK_ID}:case-practice`,
          id: 'case-practice',
          title: '案例训练',
          webviewPath: 'ui/practice.html',
        },
      ]);
      active.deactivate();
      expect(active.pages).toEqual([]);
    }
  });

  it('桥自注册：桌面声明案例页用到的通用原语，手机只读同一份数据', () => {
    // 案例页编排的全是通用原语：artifact.read 取用户显式提供的表格、llm.complete 出题与
    // 评分、data.* 读写本包声明的集合。手机端不做执行，只声明读取。
    const desktop = activateEntry(desktopActivate);
    expect(desktop.bridgeMethods).toEqual(
      expect.arrayContaining([
        'artifact.read',
        'llm.complete',
        'data.list',
        'data.get',
        'data.put',
        'data.delete',
      ]),
    );

    const mobile = activateEntry(mobileActivate);
    expect(mobile.bridgeMethods).toEqual(['data.list']);
  });

  it('练习格式映射到本包自己的面试形式，数据集合随包声明', () => {
    // 题目声明归本包所有：每个声明的 formatId 都必须落回本包注册的形式上，
    // 否则产品岗的练习在宿主侧解析不出题型。
    const declaredFormats = new Set<string>(formatIds);
    for (const form of productManagerRolePack.examForms ?? []) {
      expect(declaredFormats.has(form.formatId), `${form.id} → ${form.formatId}`).toBe(true);
    }
    // 历史行里存的旧题型取值都能在本包声明里找到对应形式
    expect(new Set((productManagerRolePack.examForms ?? []).map((form) => form.id))).toEqual(
      new Set(['concept', 'coding', 'scenario']),
    );

    // 页面按名字读写案例数据，集合必须在 manifest 里登记过，否则主进程按未声明拒掉
    expect((productManagerRolePack.manifest.dataCollections ?? []).map((item) => item.name)).toEqual(
      ['cases'],
    );
  });

  it('三种题型都提供出题、评分和话术片段，落到练习与 Story 流程上不会缺片段', () => {
    const { promptFragments } = productManagerRolePack;
    const find = (slot: PromptSlot, formatId?: string) =>
      promptFragments.find((fragment) => fragment.slot === slot && fragment.formatId === formatId);
    for (const formatId of formatIds) {
      expect(find('questionGeneration', formatId), `${formatId} 缺出题片段`).toBeTruthy();
      expect(find('scoring', formatId), `${formatId} 缺评分片段`).toBeTruthy();
      expect(find('answerCoaching', formatId), `${formatId} 缺话术片段`).toBeTruthy();
    }
    expect(find('diagnosis')).toBeTruthy();
    expect(find('explanation')).toBeTruthy();
    expect(find('debrief')).toBeTruthy();
  });

  /**
   * T14 的硬性验收：不加载 coding、QPS、repo Prompt。
   *
   * 判定方式是「片段正文必须来自包内 prompts/ 文件、不得用迁移期 ref」：只要引用
   * 任何一条 Core prompt，就等于把工程题型的口吻整段载进产品岗位。
   */
  it('全部片段由岗位包自带，不引用 Core 的任何工程 Prompt', () => {
    expect(productManagerRolePack.promptFragments.length).toBeGreaterThan(0);
    for (const fragment of productManagerRolePack.promptFragments) {
      expect(fragment.file, '片段必须来自包内 prompts/ 文件').toBeTruthy();
      expect(fragment.text, `${fragment.file} 缺正文`).toBeTruthy();
      expect(fragment.ref, '不应引用 Core prompt').toBeUndefined();
    }
  });

  it('自带片段能通过组合器的边界检查，并被记成岗位包自己的 promptId', () => {
    const slots: [PromptSlot, string | undefined][] = [
      ['diagnosis', undefined],
      ['explanation', undefined],
      ['debrief', undefined],
      ...formatIds.flatMap(
        (formatId): [PromptSlot, string][] => [
          ['questionGeneration', formatId],
          ['scoring', formatId],
          ['answerCoaching', formatId],
        ],
      ),
    ];

    for (const [slot, formatId] of slots) {
      const composed = compose(slot, formatId);
      // Core Policy 永远第一节：片段不允许把它顶掉
      expect(composed.sections[0]?.layer).toBe('corePolicy');
      expect(composed.provenance.promptId).toContain(`${PRODUCT_MANAGER_ROLE_PACK_ID}:prompts/`);
      expect(composed.provenance.promptVersionId).toContain(PRODUCT_MANAGER_ROLE_PACK_VERSION);
      // 未启用的可选能力不算这次运行时的一部分
      expect(composed.provenance.capabilityIds).toEqual([]);
    }
  });

  it('评分组合会带上本岗位包的量规锚点', () => {
    const composed = compose('scoring', PRODUCT_MANAGER_FORMAT_IDS.productCase);
    const rubricSection = composed.sections.find((section) => section.layer === 'rubric');

    expect(composed.provenance.rubricId).toBe('pm.product-case-rubric');
    expect(rubricSection?.text).toContain('成功指标与验证');
    // 工程设计的维度不应出现在产品案例的评分上下文里
    expect(rubricSection?.text).not.toContain('架构');
  });
});
