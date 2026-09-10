import { describe, expect, it } from 'vitest';
import { composePrompt } from '../../../prompts/composer';
import type { PromptEvidence, PromptRuntimeSnapshot } from '../../../prompts/composer';
import { isRegisteredPrompt } from '../../../prompts/registry';
import { validateRolePack } from '../../contracts';
import type { PromptSlot } from '../../../prompts/registry';
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

  it('是不申请任何执行权限的岗位包，能力插件只作为可选依赖', () => {
    expect(productManagerRolePack.manifest).toMatchObject({
      id: 'product-manager',
      version: '1.0.0',
      type: 'role-pack',
      compatibility: { core: '^1.0.0', schema: 23 },
      permissions: [],
      dependencies: [
        { id: 'analytics-case', version: '^1.0.0', optional: true },
        { id: 'portfolio-review', version: '^1.0.0', optional: true },
      ],
    });
    // 可选依赖必须真的可选：写成必需依赖时没装插件的用户连岗位都选不了
    for (const dependency of productManagerRolePack.manifest.dependencies ?? []) {
      expect(dependency.optional, `${dependency.id} 必须是可选依赖`).toBe(true);
    }
  });

  it('三种题型都提供出题、评分和话术片段，落到练习与 Story 流程上不会缺片段', () => {
    const { questionGeneration, scoring, answerCoaching } = productManagerRolePack.promptFragments;
    for (const formatId of formatIds) {
      expect(questionGeneration?.[formatId], `${formatId} 缺出题片段`).toBeTruthy();
      expect(scoring?.[formatId], `${formatId} 缺评分片段`).toBeTruthy();
      expect(answerCoaching?.[formatId], `${formatId} 缺话术片段`).toBeTruthy();
    }
    expect(productManagerRolePack.promptFragments.diagnosis).toBeTruthy();
    expect(productManagerRolePack.promptFragments.explanation).toBeTruthy();
    expect(productManagerRolePack.promptFragments.debrief).toBeTruthy();
  });

  /**
   * T14 的硬性验收：不加载 coding、QPS、repo Prompt。
   *
   * 按「片段是不是 registry key」判定，而不是扫关键词：Core 现有的 prompt 全部按
   * 工程题型描述任务（`diagnosis.jd` 连 examForms 都写死成 concept/coding/design/
   * scenario），产品岗位只要引用其中任意一条，就等于把那套口吻整段载进来了。
   */
  it('全部片段由岗位包自带，不引用 Core 的任何工程 Prompt', () => {
    const values = [
      productManagerRolePack.promptFragments.diagnosis,
      productManagerRolePack.promptFragments.explanation,
      productManagerRolePack.promptFragments.debrief,
      ...formatIds.flatMap((formatId) => [
        productManagerRolePack.promptFragments.questionGeneration?.[formatId],
        productManagerRolePack.promptFragments.scoring?.[formatId],
        productManagerRolePack.promptFragments.answerCoaching?.[formatId],
      ]),
    ].filter((value): value is string => value !== undefined);

    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(isRegisteredPrompt(value), `不应引用 Core prompt：${value}`).toBe(false);
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
      expect(composed.provenance.promptId).toContain(`${PRODUCT_MANAGER_ROLE_PACK_ID}#${slot}`);
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
