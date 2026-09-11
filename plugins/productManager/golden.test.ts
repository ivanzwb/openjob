import { describe, expect, it } from 'vitest';
import { composePrompt } from '@core/prompts/composer';
import { resolvePracticeFormat } from '@core/practice';
import { BuiltInPluginRegistry } from '@core/plugins/registry';
import { DeterministicRuntimeResolver } from '@core/plugins/resolver';
import { softwareEngineeringRolePack } from '../softwareEngineering';
import {
  CORE_CAPABILITIES_PACK_ID,
  CORE_CAPABILITIES_PACK_VERSION,
  coreCapabilitiesSuite,
} from '@core/plugins/capabilitySuite';
import { DISTRIBUTED_ROLE_PACKS } from '..';
import {
  PRODUCT_MANAGER_FORMAT_IDS,
  PRODUCT_MANAGER_OPTIONAL_CAPABILITY_IDS,
  PRODUCT_MANAGER_ROLE_PACK_ID,
  productManagerRolePack,
} from './index';

interface RoleGolden {
  title: string;
  jd: string;
  matches: boolean;
}

const ROLE_GOLDENS: RoleGolden[] = [
  {
    title: 'Senior Product Manager',
    jd: 'Own the product roadmap, run user research, define metrics and prioritization.',
    matches: true,
  },
  {
    title: '产品经理',
    jd: '负责产品规划、用户调研、需求优先级与数据指标复盘。',
    matches: true,
  },
  {
    title: '数据产品经理',
    jd: '负责数据产品规划，与研发协作推动指标体系落地。',
    matches: true,
  },
  {
    title: 'Product Owner',
    jd: 'Maintain the backlog, align stakeholders, and ship iteratively.',
    matches: true,
  },
  {
    title: 'Senior Backend Engineer',
    jd: 'Design distributed systems, review code, and improve service reliability.',
    matches: false,
  },
  {
    title: '前端开发工程师',
    jd: '负责 TypeScript 应用架构、性能优化与自动化测试。',
    matches: false,
  },
  {
    title: '客户成功经理',
    jd: '负责客户续约、异议处理和价值沟通。',
    matches: false,
  },
];

function matchesProductManagerRole(title: string, jd: string): boolean {
  return productManagerRolePack.roleMatchers.some((matcher) => {
    const titleMatches = matcher.titlePatterns.some((pattern) =>
      new RegExp(pattern, 'i').test(title),
    );
    const excluded = (matcher.excludeSignals ?? []).some((signal) =>
      jd.toLocaleLowerCase().includes(signal.toLocaleLowerCase()),
    );
    return titleMatches && !excluded;
  });
}

/** 岗位包自己声明的四张表；Core 基线与工程口吻都不该出现在这里。 */
const roleOwnedText = JSON.stringify({
  competencies: productManagerRolePack.competencyTemplates,
  stages: productManagerRolePack.interviewStages,
  formats: productManagerRolePack.interviewFormats,
  tasks: productManagerRolePack.taskTemplates,
}).toLocaleLowerCase();

function resolveWith(
  capabilityPlugins: readonly (typeof coreCapabilitiesSuite)[],
): ReturnType<DeterministicRuntimeResolver['resolve']> {
  const registry = new BuiltInPluginRegistry();
  DISTRIBUTED_ROLE_PACKS.forEach((pack) => registry.register(pack));
  capabilityPlugins.forEach((plugin) => registry.registerCapability(plugin));
  return new DeterministicRuntimeResolver(registry).resolve({
    coreVersion: '1.0.0',
    schemaVersion: 23,
    rolePackId: PRODUCT_MANAGER_ROLE_PACK_ID,
    capabilityIds: [],
  });
}

/**
 * 真的把可选能力从本机清单里摘掉。
 *
 * 原来这里注册的是全部内置能力，只靠 `capabilityIds: []` 表达「没装」——可
 * resolver 会自动接受**已安装**的可选依赖，于是 analytics-case 一旦真被实现，
 * 这条用例就从「没装也能跑」悄悄变成「装了也能跑」，再也盖不住它本来要盖的路径。
 */
function resolveWithoutOptionalCapabilities(): ReturnType<DeterministicRuntimeResolver['resolve']> {
  // 内置清单已清空：可选能力没装 = 本机不注册合编包
  return resolveWith([]);
}

describe('product manager role pack goldens', () => {
  it.each(ROLE_GOLDENS)('classifies $title without cross-role contamination', (golden) => {
    expect(matchesProductManagerRole(golden.title, golden.jd)).toBe(golden.matches);
  });

  it('保持稳定的产品能力与量规基线', () => {
    expect(productManagerRolePack.competencyTemplates.map(({ id }) => id)).toEqual([
      'pm.problem-framing',
      'pm.user-insight',
      'pm.metrics',
      'pm.prioritization',
      'pm.product-decision',
    ]);
    expect(
      productManagerRolePack.rubrics.map((rubric) => ({
        id: rubric.id,
        dimensions: rubric.dimensions.map((dimension) => dimension.id),
      })),
    ).toEqual([
      {
        id: 'pm.product-case-rubric',
        dimensions: [
          'problem-definition',
          'user-and-market-insight',
          'solution-and-prioritization',
          'success-metrics',
        ],
      },
      {
        id: 'pm.behavioral-rubric',
        dimensions: [
          'ownership-and-influence',
          'stakeholder-communication',
          'product-judgment',
          'outcome-reflection',
        ],
      },
      {
        id: 'pm.product-presentation-rubric',
        dimensions: [
          'narrative-structure',
          'audience-adaptation',
          'evidence-and-visuals',
          'qa-handling',
        ],
      },
    ]);
  });

  it('声明 case、behavioral 和 presentation 三种交互协议', () => {
    expect(
      productManagerRolePack.interviewFormats.map((format) => [format.id, format.protocol]),
    ).toEqual([
      [PRODUCT_MANAGER_FORMAT_IDS.productCase, 'case'],
      [PRODUCT_MANAGER_FORMAT_IDS.behavioral, 'behavioral'],
      [PRODUCT_MANAGER_FORMAT_IDS.presentation, 'presentation'],
    ]);
  });

  it('不携带任何工程能力、工程考法或工程任务', () => {
    for (const engineeringMarker of [
      '算法',
      '分布式',
      '系统设计',
      '编码',
      '代码',
      '吞吐',
      'qps',
      'coding',
      'readcode',
      'repo',
    ]) {
      expect(roleOwnedText, `工程口吻泄漏：${engineeringMarker}`).not.toContain(
        engineeringMarker.toLocaleLowerCase(),
      );
    }

    const ownedIds = [
      ...productManagerRolePack.competencyTemplates.map(({ id }) => id),
      ...productManagerRolePack.interviewStages.map(({ id }) => id),
      ...productManagerRolePack.interviewFormats.map(({ id }) => id),
      ...productManagerRolePack.rubrics.map(({ id }) => id),
      ...productManagerRolePack.taskTemplates.map(({ id }) => id),
    ];
    expect(ownedIds.every((id) => id.startsWith('pm.'))).toBe(true);
    expect(
      productManagerRolePack.taskTemplates.map((task) => task.taskKind),
    ).not.toContain('readCode');
  });

  it('把 Core 的通用面试基线留给 Core', () => {
    for (const coreBaselineMarker of [
      'selfintro',
      'self-introduction',
      '自我介绍',
      '求职动机',
      '优势与短板',
      '冲突',
      '失败',
      '反问面试官',
    ]) {
      expect(roleOwnedText, `Core baseline leaked: ${coreBaselineMarker}`).not.toContain(
        coreBaselineMarker.toLocaleLowerCase(),
      );
    }
  });

  /**
   * T14 的验收之一：产品案例评分与工程设计评分维度显著不同。
   *
   * 维度 ID 重名比分数不准更危险：两套量规一旦共用维度名，跨岗位的历史评分就会
   * 被当成同一把尺子放在一起比较，而它们衡量的根本不是同一件事。
   */
  it('产品案例量规与工程设计量规没有任何共用维度', () => {
    const productCase = productManagerRolePack.rubrics.find(
      (rubric) => rubric.id === 'pm.product-case-rubric',
    );
    const systemDesign = softwareEngineeringRolePack.rubrics.find(
      (rubric) => rubric.id === 'se.system-design-rubric',
    );

    const productDimensions = new Set(productCase?.dimensions.map(({ id }) => id));
    const engineeringDimensions = systemDesign?.dimensions.map(({ id }) => id) ?? [];

    expect(productDimensions.size).toBeGreaterThan(0);
    expect(engineeringDimensions.length).toBeGreaterThan(0);
    expect(engineeringDimensions.filter((id) => productDimensions.has(id))).toEqual([]);
  });

  it('没装 analytics-case 时仍然能完整跑纯文本产品案例', () => {
    const resolved = resolveWithoutOptionalCapabilities();
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    // 可选能力缺席只降级成 disabled，不让整次解析失败
    for (const capabilityId of Object.values(PRODUCT_MANAGER_OPTIONAL_CAPABILITY_IDS)) {
      const ref = resolved.descriptor.capabilities.find((item) => item.id === capabilityId);
      expect(ref, `${capabilityId} 应作为未启用能力出现在描述符里`).toBeDefined();
      expect(ref?.enabled).toBe(false);
      expect(ref?.enabled === false ? ref.disabledReason : '').toContain('plugin-not-found');
    }

    // 案例题不挂能力插件，题型与量规照常可解析
    const { format, rubric } = resolvePracticeFormat(
      productManagerRolePack,
      PRODUCT_MANAGER_FORMAT_IDS.productCase,
    );
    expect(format.capabilityId).toBeUndefined();
    expect(rubric.dimensions).toHaveLength(4);

    // 出题与评分都能在缺能力的运行时下组合出来
    for (const slot of ['questionGeneration', 'scoring'] as const) {
      const composed = composePrompt({
        runtime: resolved.descriptor,
        rolePack: productManagerRolePack,
        slot,
        formatId: PRODUCT_MANAGER_FORMAT_IDS.productCase,
      });
      expect(composed.systemPrompt).toContain('产品案例');
      expect(composed.provenance.capabilityIds).toEqual([]);
    }
  });

  it('装了 analytics-case 时产品岗自动把它启用', () => {
    const resolved = resolveWith([coreCapabilitiesSuite]);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const ref = resolved.descriptor.capabilities.find(
      (item) => item.id === CORE_CAPABILITIES_PACK_ID,
    );
    // 可选依赖装上了就该生效，用户不必再手动勾一次
    // 三个能力并入一个包：产品岗自动启用的是合编包整体
    expect(ref).toMatchObject({ enabled: true, version: CORE_CAPABILITIES_PACK_VERSION });

    // 但它只是加强项：案例题依然不绑能力插件，纯文本路径不受影响
    const { format } = resolvePracticeFormat(
      productManagerRolePack,
      PRODUCT_MANAGER_FORMAT_IDS.productCase,
    );
    expect(format.capabilityId).toBeUndefined();
  });

  it('保持产品岗位自己的检索可信度与时效策略', () => {
    expect(productManagerRolePack.sourcePolicy).toEqual({
      preferredDomains: [
        'woshipm.com',
        'pmcaff.com',
        'lenny.substack.com',
        'svpg.com',
        'mindtheproduct.com',
        'nowcoder.com',
        'zhihu.com',
        '1point3acres.com',
      ],
      credibilityOverrides: {
        'svpg.com': 5,
        'lenny.substack.com': 4,
        'mindtheproduct.com': 4,
        'woshipm.com': 3,
        'pmcaff.com': 3,
        'nowcoder.com': 3,
        'zhihu.com': 3,
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
