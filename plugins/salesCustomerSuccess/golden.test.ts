import { describe, expect, it } from 'vitest';
import { resolvePracticeFormat } from '@shared/practice';
import { composePrompt } from '@shared/prompts/composer';
import { BuiltInPluginRegistry } from '@shared/plugins/registry';
import { DeterministicRuntimeResolver } from '@shared/plugins/resolver';
import { BUILT_IN_CAPABILITY_PLUGINS } from '@shared/plugins/builtin';
import { DISTRIBUTED_ROLE_PACKS } from '..';
import { productManagerRolePack } from '../productManager';
import { softwareEngineeringRolePack } from '../softwareEngineering';
import {
  SALES_CUSTOMER_SUCCESS_FORMAT_IDS,
  SALES_CUSTOMER_SUCCESS_ROLE_PACK_ID,
  SALES_ROLE_PLAY_CAPABILITY_ID,
  salesCustomerSuccessRolePack,
} from './index';

interface RoleGolden {
  title: string;
  jd: string;
  matches: boolean;
}

const ROLE_GOLDENS: RoleGolden[] = [
  {
    title: 'Enterprise Account Executive',
    jd: 'Own quota, build pipeline, run prospecting and close new business.',
    matches: true,
  },
  {
    title: 'Customer Success Manager',
    jd: 'Drive renewal and upsell, own customer onboarding and adoption.',
    matches: true,
  },
  {
    title: '大客户销售经理',
    jd: '负责华东区大客户拓展、商务谈判与回款，完成年度销售目标。',
    matches: true,
  },
  {
    title: '客户成功经理',
    jd: '负责客户续约、异议处理和价值沟通。',
    matches: true,
  },
  {
    title: '售前顾问',
    jd: '配合销售完成客户需求调研与方案讲解，推动商务落地。',
    matches: true,
  },
  /**
   * 后缀必须存在才算命中。
   *
   * 标题命中就直接入选、只有 JD 里的 excludeSignals 才能否决，所以「销售」这两个
   * 字出现在一个工程岗位名里是最容易误收的情形——这条用例专门盯它。
   */
  {
    title: '销售系统开发工程师',
    jd: '负责销售中台的服务端开发，熟悉分布式事务与性能优化。',
    matches: false,
  },
  {
    title: 'Senior Backend Engineer',
    jd: 'Design distributed systems, review code, and improve service reliability.',
    matches: false,
  },
  {
    title: '产品经理',
    jd: '负责产品规划、用户调研、需求优先级与数据指标复盘。',
    matches: false,
  },
];

function matchesSalesRole(title: string, jd: string): boolean {
  return salesCustomerSuccessRolePack.roleMatchers.some((matcher) => {
    const titleMatches = matcher.titlePatterns.some((pattern) =>
      new RegExp(pattern, 'i').test(title),
    );
    const excluded = (matcher.excludeSignals ?? []).some((signal) =>
      jd.toLocaleLowerCase().includes(signal.toLocaleLowerCase()),
    );
    return titleMatches && !excluded;
  });
}

/**
 * 销售岗位不该出现的工程口吻。
 *
 * 「技术准确性」和「吞吐」是验收明确点名的两条：销售的高分与低分差在能不能问出
 * 真实痛点、能不能推进决策，用工程口径打分等于换了一把尺子量。
 */
const ENGINEERING_MARKERS = [
  'qps',
  'coding',
  'readcode',
  'repo',
  '技术准确性',
  '系统设计',
  '分布式',
  '吞吐',
  '容量',
  '编码',
  '算法题',
  '源码',
] as const;

/** 岗位包自己声明的四张表；Core 基线与工程口吻都不该出现在这里。 */
const roleOwnedText = JSON.stringify({
  competencies: salesCustomerSuccessRolePack.competencyTemplates,
  stages: salesCustomerSuccessRolePack.interviewStages,
  formats: salesCustomerSuccessRolePack.interviewFormats,
  tasks: salesCustomerSuccessRolePack.taskTemplates,
}).toLocaleLowerCase();

/** 不挂 capabilityId 的题型：降级之后的面试蓝图只能由这些构成。 */
function ungatedFormatIds(): string[] {
  return salesCustomerSuccessRolePack.interviewFormats
    .filter((format) => format.capabilityId === undefined)
    .map((format) => format.id);
}

function resolveWithoutRolePlay(): ReturnType<DeterministicRuntimeResolver['resolve']> {
  const registry = new BuiltInPluginRegistry();
  DISTRIBUTED_ROLE_PACKS.forEach((pack) => registry.register(pack));
  // 明确把 role-play 排除掉。本用例考的是「插件缺席时如何降级」，
  // 原先靠「仓库里还没实现 role-play」这个前提成立，T19 把它实现出来后前提就失效了。
  BUILT_IN_CAPABILITY_PLUGINS.filter(
    (plugin) => plugin.manifest.id !== SALES_ROLE_PLAY_CAPABILITY_ID,
  ).forEach((plugin) => registry.registerCapability(plugin));
  return new DeterministicRuntimeResolver(registry).resolve({
    coreVersion: '1.0.0',
    schemaVersion: 23,
    rolePackId: SALES_CUSTOMER_SUCCESS_ROLE_PACK_ID,
    capabilityIds: [],
  });
}

describe('sales & customer success role pack goldens', () => {
  it.each(ROLE_GOLDENS)('classifies $title without cross-role contamination', (golden) => {
    expect(matchesSalesRole(golden.title, golden.jd)).toBe(golden.matches);
  });

  it('保持稳定的销售能力与量规基线', () => {
    expect(salesCustomerSuccessRolePack.competencyTemplates.map(({ id }) => id)).toEqual([
      'sales.discovery',
      'sales.value-articulation',
      'sales.objection-handling',
      'sales.negotiation',
      'sales.pipeline',
    ]);
    expect(
      salesCustomerSuccessRolePack.rubrics.map((rubric) => ({
        id: rubric.id,
        dimensions: rubric.dimensions.map((dimension) => dimension.id),
      })),
    ).toEqual([
      {
        id: 'sales.role-play-rubric',
        dimensions: ['listening', 'clarifying', 'adaptability', 'advancing'],
      },
      {
        id: 'sales.behavioral-rubric',
        dimensions: [
          'customer-diagnosis-depth',
          'value-translation',
          'trust-and-objection',
          'result-attribution',
        ],
      },
    ]);
  });

  it('能力与阶段权重各自归一，蓝图不会因为某一轮缺席而失真', () => {
    const competencyWeight = salesCustomerSuccessRolePack.competencyTemplates.reduce(
      (sum, template) => sum + template.defaultWeight,
      0,
    );
    const stageWeight = salesCustomerSuccessRolePack.interviewStages.reduce(
      (sum, stage) => sum + stage.defaultWeight,
      0,
    );
    expect(competencyWeight).toBeCloseTo(1, 10);
    expect(stageWeight).toBeCloseTo(1, 10);

    for (const rubric of salesCustomerSuccessRolePack.rubrics) {
      const total = rubric.dimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
      expect(total, rubric.id).toBeCloseTo(1, 10);
    }
  });

  it('提供 behavioral 与 role-play 两种题型，对话题型声明依赖角色扮演能力', () => {
    const protocols = salesCustomerSuccessRolePack.interviewFormats.map(
      (format) => format.protocol,
    );
    expect(protocols).toEqual(['behavioral', 'role-play']);

    const rolePlay = salesCustomerSuccessRolePack.interviewFormats.find(
      (format) => format.id === SALES_CUSTOMER_SUCCESS_FORMAT_IDS.customerRolePlay,
    );
    expect(rolePlay?.capabilityId).toBe(SALES_ROLE_PLAY_CAPABILITY_ID);
    // 行为面是降级后的落点，绑了能力就没有退路了
    expect(
      salesCustomerSuccessRolePack.interviewFormats.find(
        (format) => format.id === SALES_CUSTOMER_SUCCESS_FORMAT_IDS.behavioral,
      )?.capabilityId,
    ).toBeUndefined();
  });

  /**
   * T18 硬性验收：无 role-play 插件时可降级为文本行为题。
   *
   * 降级不靠 Core 里加判断（那会改动 Practice Engine），而是靠声明本身成立：
   * 需要对话的两轮同时列出文本行为题，于是每条能力、每一轮都还有一个不依赖任何
   * 能力插件的题型。少了这条性质，没装插件的用户会在蓝图里看到两轮空白。
   */
  it('没装 role-play 时每条能力和每一轮都还有不依赖插件的题型', () => {
    const ungated = new Set(ungatedFormatIds());
    expect(ungated.size).toBeGreaterThan(0);

    for (const template of salesCustomerSuccessRolePack.competencyTemplates) {
      const usable = template.supportedFormats.filter((formatId) => ungated.has(formatId));
      expect(usable.length, `${template.id} 在降级后无题型可考`).toBeGreaterThan(0);
    }

    for (const stage of salesCustomerSuccessRolePack.interviewStages) {
      const usable = stage.formatIds.filter((formatId) => ungated.has(formatId));
      expect(usable.length, `${stage.id} 在降级后无题型可用`).toBeGreaterThan(0);
    }

    // 需要对话的两轮把 role-play 排在前面：顺序即优先级，装了插件才用得上
    const conversationStages = salesCustomerSuccessRolePack.interviewStages.filter((stage) =>
      stage.formatIds.includes(SALES_CUSTOMER_SUCCESS_FORMAT_IDS.customerRolePlay),
    );
    expect(conversationStages.length).toBe(2);
    for (const stage of conversationStages) {
      expect(stage.formatIds[0]).toBe(SALES_CUSTOMER_SUCCESS_FORMAT_IDS.customerRolePlay);
      expect(stage.formatIds).toContain(SALES_CUSTOMER_SUCCESS_FORMAT_IDS.behavioral);
    }
  });

  it('装了 role-play 时对话题型所依赖的能力被启用', () => {
    const registry = new BuiltInPluginRegistry();
    DISTRIBUTED_ROLE_PACKS.forEach((pack) => registry.register(pack));
    BUILT_IN_CAPABILITY_PLUGINS.forEach((plugin) => registry.registerCapability(plugin));
    const resolved = new DeterministicRuntimeResolver(registry).resolve({
      coreVersion: '1.0.0',
      schemaVersion: 23,
      rolePackId: SALES_CUSTOMER_SUCCESS_ROLE_PACK_ID,
      capabilityIds: [],
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const ref = resolved.descriptor.capabilities.find(
      (item) => item.id === SALES_ROLE_PLAY_CAPABILITY_ID,
    );
    expect(ref?.enabled).toBe(true);
  });

  it('没装 role-play 时行为面仍然完整跑得通，且解析不失败', () => {
    const resolved = resolveWithoutRolePlay();
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    // 可选能力缺席只降级成 disabled，不让整次解析失败
    const ref = resolved.descriptor.capabilities.find(
      (item) => item.id === SALES_ROLE_PLAY_CAPABILITY_ID,
    );
    expect(ref?.enabled).toBe(false);
    expect(ref?.enabled === false ? ref.disabledReason : '').toContain('plugin-not-found');

    const { format, rubric } = resolvePracticeFormat(
      salesCustomerSuccessRolePack,
      SALES_CUSTOMER_SUCCESS_FORMAT_IDS.behavioral,
    );
    expect(format.capabilityId).toBeUndefined();
    expect(rubric.dimensions).toHaveLength(4);

    for (const slot of ['questionGeneration', 'scoring'] as const) {
      const composed = composePrompt({
        runtime: resolved.descriptor,
        rolePack: salesCustomerSuccessRolePack,
        slot,
        formatId: SALES_CUSTOMER_SUCCESS_FORMAT_IDS.behavioral,
      });
      expect(composed.systemPrompt).toContain('销售行为面');
      expect(composed.provenance.capabilityIds).toEqual([]);
    }
  });

  /**
   * T18 硬性验收：评分不使用技术准确性 / QPS 等工程维度。
   *
   * 扫的是岗位包自己声明的四张表加两份量规的全文：销售的高分与低分差在能不能问出
   * 真实痛点、能不能推进决策，与实现细节无关。
   */
  it('声明里不含任何工程口吻', () => {
    const rubricText = JSON.stringify(salesCustomerSuccessRolePack.rubrics).toLocaleLowerCase();

    // 正向对照：扫的确实是这个岗位包的文本。取错了对象下面几条断言就只是空跑
    expect(roleOwnedText).toContain('客户诊断与需求挖掘');
    expect(rubricText).toContain('倾听与信息接收');

    for (const marker of ENGINEERING_MARKERS) {
      const lowered = marker.toLocaleLowerCase();
      expect(roleOwnedText, `岗位声明里出现工程口吻：${marker}`).not.toContain(lowered);
      expect(rubricText, `量规里出现工程口吻：${marker}`).not.toContain(lowered);
    }

    for (const id of salesCustomerSuccessRolePack.competencyTemplates.map(({ id }) => id)) {
      expect(id.startsWith('sales.')).toBe(true);
    }
  });

  /**
   * 声明干净不等于送给模型的文本干净：片段自己没写工程口吻，组合时仍可能被别的
   * 层追加进来，而用户看到的是最终那一份。所以这里扫的是 systemPrompt 全文。
   */
  it('组合出来的 Prompt 全文也不含工程口吻', () => {
    const resolved = resolveWithoutRolePlay();
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const evidence = [
      {
        id: 'ev-1',
        kind: 'achievement',
        statement: '负责华东区新签，年度完成率 118%。',
        userConfirmed: true,
      },
    ];
    const texts = Object.values(SALES_CUSTOMER_SUCCESS_FORMAT_IDS).flatMap((formatId) =>
      (['questionGeneration', 'scoring', 'answerCoaching'] as const).map(
        (slot) =>
          composePrompt({
            runtime: resolved.descriptor,
            rolePack: salesCustomerSuccessRolePack,
            slot,
            formatId,
            evidence,
          }).systemPrompt,
      ),
    );

    expect(texts).toHaveLength(Object.keys(SALES_CUSTOMER_SUCCESS_FORMAT_IDS).length * 3);
    for (const text of texts) {
      const lowered = text.toLocaleLowerCase();
      for (const marker of ENGINEERING_MARKERS) {
        expect(lowered, `工程口吻泄漏：${marker}`).not.toContain(marker.toLocaleLowerCase());
      }
    }
  });

  /**
   * Core 基线题（自我介绍、求职动机、优劣势、分歧与挫折、反问）由基础 Agent 统一
   * 出，岗位包不许自己再写一份——写了就会和基线重复问一遍。
   */
  it('声明里不含 Core 基线题的标记', () => {
    const banned = [
      'selfintro',
      'self-introduction',
      '自我介绍',
      '求职动机',
      '优势与短板',
      '冲突',
      '失败',
      '反问面试官',
    ];
    expect(roleOwnedText).toContain('异议处理与信任建立');
    for (const marker of banned) {
      expect(roleOwnedText, `与 Core 基线重复：${marker}`).not.toContain(
        marker.toLocaleLowerCase(),
      );
    }
  });

  /**
   * 三个岗位包的量规维度必须两两不相交。
   *
   * 同名维度会让跨岗位的历史评分被放进同一张趋势图，而它们衡量的根本不是同一件
   * 事——「倾听」和「技术准确性」放在一起比较没有任何意义。
   */
  it('量规维度与工程、产品两个岗位包都不重叠', () => {
    const dimensionsOf = (pack: typeof salesCustomerSuccessRolePack): Set<string> =>
      new Set(pack.rubrics.flatMap((rubric) => rubric.dimensions.map(({ id }) => id)));

    const sales = dimensionsOf(salesCustomerSuccessRolePack);
    const engineering = dimensionsOf(softwareEngineeringRolePack);
    const product = dimensionsOf(productManagerRolePack);

    expect(sales.size).toBeGreaterThan(0);
    expect([...engineering].filter((id) => sales.has(id))).toEqual([]);
    expect([...product].filter((id) => sales.has(id))).toEqual([]);
  });

  it('检索策略保持行业中立，不收录任何厂商销售博客', () => {
    expect(salesCustomerSuccessRolePack.sourcePolicy).toEqual({
      preferredDomains: [
        'hbr.org',
        'gartner.com',
        'mckinsey.com',
        'nowcoder.com',
        'zhihu.com',
        'linkedin.com',
        '1point3acres.com',
      ],
      credibilityOverrides: {
        'hbr.org': 5,
        'gartner.com': 4,
        'mckinsey.com': 4,
        'nowcoder.com': 3,
        'zhihu.com': 3,
        'linkedin.com': 3,
        '1point3acres.com': 3,
      },
      freshnessDays: {
        companyIntel: 7,
        interviewReports: 3,
        domainKnowledge: 730,
      },
    });
  });
});
