import { describe, expect, it } from 'vitest';
import { composePrompt } from '../../../prompts/composer';
import type { PromptEvidence, PromptRuntimeSnapshot } from '../../../prompts/composer';
import { isRegisteredPrompt } from '../../../prompts/registry';
import type { PromptSlot } from '../../../prompts/registry';
import { validateRolePack } from '../../contracts';
import {
  SALES_CUSTOMER_SUCCESS_FORMAT_IDS,
  SALES_CUSTOMER_SUCCESS_ROLE_PACK_ID,
  SALES_CUSTOMER_SUCCESS_ROLE_PACK_VERSION,
  SALES_ROLE_PLAY_CAPABILITY_ID,
  salesCustomerSuccessRolePack,
} from './index';

const formatIds = Object.values(SALES_CUSTOMER_SUCCESS_FORMAT_IDS);

/** role-play 没装：这就是 T18 要求的最小可用环境。 */
const RUNTIME: PromptRuntimeSnapshot = {
  coreVersion: '1.0.0',
  rolePack: {
    id: SALES_CUSTOMER_SUCCESS_ROLE_PACK_ID,
    version: SALES_CUSTOMER_SUCCESS_ROLE_PACK_VERSION,
  },
  capabilities: [
    {
      id: SALES_ROLE_PLAY_CAPABILITY_ID,
      enabled: false as const,
      disabledReason: `plugin-not-found: 插件未安装：${SALES_ROLE_PLAY_CAPABILITY_ID}`,
    },
  ],
  configSnapshotHash: 'sales-contract-test',
};

const EVIDENCE: PromptEvidence[] = [
  {
    id: 'ev-1',
    kind: 'achievement',
    statement: '负责华东区新签，年度完成率 118%，最大单笔合同 240 万。',
    userConfirmed: true,
  },
];

function compose(slot: PromptSlot, formatId?: string): ReturnType<typeof composePrompt> {
  return composePrompt({
    runtime: RUNTIME,
    rolePack: salesCustomerSuccessRolePack,
    slot,
    formatId,
    evidence: EVIDENCE,
  });
}

describe('salesCustomerSuccessRolePack contract', () => {
  it('通过 T01 的 RolePack 校验', () => {
    expect(validateRolePack(salesCustomerSuccessRolePack)).toEqual([]);
  });

  it('是不申请任何执行权限的岗位包，角色扮演只作为可选依赖', () => {
    expect(salesCustomerSuccessRolePack.manifest).toMatchObject({
      id: 'sales-customer-success',
      version: '1.0.0',
      type: 'role-pack',
      compatibility: { core: '^1.0.0', schema: 23 },
      permissions: [],
      dependencies: [{ id: SALES_ROLE_PLAY_CAPABILITY_ID, version: '^1.0.0', optional: true }],
    });
    // 写成必需依赖时，T19 交付之前谁都选不了这个岗位
    for (const dependency of salesCustomerSuccessRolePack.manifest.dependencies ?? []) {
      expect(dependency.optional, `${dependency.id} 必须是可选依赖`).toBe(true);
    }
  });

  it('两种题型都提供出题、评分和话术片段，落到练习与 Story 流程上不会缺片段', () => {
    const { questionGeneration, scoring, answerCoaching } =
      salesCustomerSuccessRolePack.promptFragments;
    for (const formatId of formatIds) {
      expect(questionGeneration?.[formatId], `${formatId} 缺出题片段`).toBeTruthy();
      expect(scoring?.[formatId], `${formatId} 缺评分片段`).toBeTruthy();
      expect(answerCoaching?.[formatId], `${formatId} 缺话术片段`).toBeTruthy();
    }
    expect(salesCustomerSuccessRolePack.promptFragments.diagnosis).toBeTruthy();
    expect(salesCustomerSuccessRolePack.promptFragments.explanation).toBeTruthy();
    expect(salesCustomerSuccessRolePack.promptFragments.debrief).toBeTruthy();
  });

  /**
   * 按「片段是不是 registry key」判定，而不是扫关键词：Core 现有的 prompt 全部按
   * 工程题型描述任务，销售岗位引用其中任意一条就等于把那套口吻整段载进来。
   */
  it('全部片段由岗位包自带，不引用 Core 的任何工程 Prompt', () => {
    const values = [
      salesCustomerSuccessRolePack.promptFragments.diagnosis,
      salesCustomerSuccessRolePack.promptFragments.explanation,
      salesCustomerSuccessRolePack.promptFragments.debrief,
      ...formatIds.flatMap((formatId) => [
        salesCustomerSuccessRolePack.promptFragments.questionGeneration?.[formatId],
        salesCustomerSuccessRolePack.promptFragments.scoring?.[formatId],
        salesCustomerSuccessRolePack.promptFragments.answerCoaching?.[formatId],
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
      ...formatIds.flatMap((formatId): [PromptSlot, string][] => [
        ['questionGeneration', formatId],
        ['scoring', formatId],
        ['answerCoaching', formatId],
      ]),
    ];

    for (const [slot, formatId] of slots) {
      const composed = compose(slot, formatId);
      // Core Policy 永远第一节：片段不允许把它顶掉
      expect(composed.sections[0]?.layer).toBe('corePolicy');
      expect(composed.provenance.promptId).toContain(
        `${SALES_CUSTOMER_SUCCESS_ROLE_PACK_ID}#${slot}`,
      );
      expect(composed.provenance.promptVersionId).toContain(
        SALES_CUSTOMER_SUCCESS_ROLE_PACK_VERSION,
      );
      // 未启用的可选能力不算这次运行时的一部分
      expect(composed.provenance.capabilityIds).toEqual([]);
    }
  });

  it('评分组合会带上本岗位包的量规锚点', () => {
    const composed = compose('scoring', SALES_CUSTOMER_SUCCESS_FORMAT_IDS.customerRolePlay);
    const rubricSection = composed.sections.find((section) => section.layer === 'rubric');

    expect(composed.provenance.rubricId).toBe('sales.role-play-rubric');
    expect(rubricSection?.text).toContain('倾听与信息接收');
    // 工程口径不应出现在销售的评分上下文里
    expect(rubricSection?.text).not.toContain('架构');
  });
});
