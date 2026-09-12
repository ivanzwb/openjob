/**
 * 一个完整的非工程岗位包，专门用来钉住「非工程岗位不产生工程能力污染」。
 *
 * 刻意不做成三五行的假对象：诊断读的是 competencyTemplates、interviewStages、
 * interviewFormats 和 taskTemplates 四张表，缺任何一张都会让用例绕开真实路径。
 * 用例会先用 validateRolePack 校一遍，保证它和内置包受同一套约束。
 */

import type { RolePack, RubricAnchors } from '../../plugins/types';

export const PRODUCT_MANAGEMENT_FORMAT_IDS = {
  productCase: 'pm.product-case',
  behavioral: 'pm.behavioral',
} as const;

function anchors(
  one: string,
  two: string,
  three: string,
  four: string,
  five: string,
): RubricAnchors {
  return { 1: one, 2: two, 3: three, 4: four, 5: five };
}

export const productManagementRolePack: RolePack = {
  manifest: {
    id: 'product-management',
    version: '1.0.0',
    type: 'role-pack',
    displayName: '产品管理',
    description: '产品经理岗位的能力诊断与模拟面试声明',
    compatibility: { core: '^1.0.0', schema: 23 },
    permissions: [],
  },
  roleMatchers: [
    {
      titlePatterns: ['\\bproduct\\s+manager\\b', '产品经理'],
      responsibilitySignals: ['产品路线图', '用户调研', 'roadmap'],
    },
  ],
  competencyTemplates: [
    {
      id: 'pm.problem-framing',
      name: '问题定义与拆解',
      category: 'skill',
      description: '把模糊诉求收敛成可判断的目标、范围和成功指标',
      defaultWeight: 0.4,
      levelIndicators: [
        { level: 1, behavior: '直接跳到方案，说不清要解决什么' },
        { level: 3, behavior: '能界定目标人群、范围和成功指标' },
        { level: 5, behavior: '能量化机会大小并说明放弃了哪些方向' },
      ],
      evidenceKinds: ['experience', 'achievement'],
      supportedFormats: [PRODUCT_MANAGEMENT_FORMAT_IDS.productCase],
    },
    {
      id: 'pm.user-insight',
      name: '用户洞察与调研',
      category: 'knowledge',
      description: '通过访谈、数据和竞品分析得到可行动的用户结论',
      defaultWeight: 0.35,
      levelIndicators: [
        { level: 1, behavior: '只凭个人直觉判断用户诉求' },
        { level: 3, behavior: '能组织调研并归纳出可行动结论' },
        { level: 5, behavior: '能交叉验证定性定量结论并预判偏差' },
      ],
      evidenceKinds: ['experience', 'achievement', 'skill'],
      supportedFormats: [
        PRODUCT_MANAGEMENT_FORMAT_IDS.productCase,
        PRODUCT_MANAGEMENT_FORMAT_IDS.behavioral,
      ],
    },
    {
      id: 'pm.stakeholder-alignment',
      name: '跨团队推动与对齐',
      category: 'behavior',
      description: '在资源冲突下推动研发、设计和业务达成一致并落地',
      defaultWeight: 0.25,
      levelIndicators: [
        { level: 1, behavior: '只能转述他人意见，推不动决策' },
        { level: 3, behavior: '能说明分歧点并促成一次明确决策' },
        { level: 5, behavior: '能重建高冲突场景下的推动路径和取舍' },
      ],
      evidenceKinds: ['behavior', 'experience'],
      supportedFormats: [PRODUCT_MANAGEMENT_FORMAT_IDS.behavioral],
    },
  ],
  interviewStages: [
    {
      id: 'pm.screen',
      label: '产品初筛',
      order: 0,
      formatIds: [PRODUCT_MANAGEMENT_FORMAT_IDS.behavioral],
      defaultWeight: 0.4,
    },
    {
      id: 'pm.case-interview',
      label: '产品案例面',
      order: 1,
      formatIds: [PRODUCT_MANAGEMENT_FORMAT_IDS.productCase],
      defaultWeight: 0.6,
    },
  ],
  interviewFormats: [
    {
      id: PRODUCT_MANAGEMENT_FORMAT_IDS.productCase,
      label: '产品案例',
      protocol: 'case',
      defaultDurationMinutes: 45,
      followUpPolicy: { maxRounds: 3, strategy: 'adaptive' },
      rubricId: 'pm.product-case-rubric',
    },
    {
      id: PRODUCT_MANAGEMENT_FORMAT_IDS.behavioral,
      label: '行为面试',
      protocol: 'behavioral',
      defaultDurationMinutes: 30,
      followUpPolicy: { maxRounds: 3, strategy: 'adaptive' },
      rubricId: 'pm.behavioral-rubric',
    },
  ],
  rubrics: [
    {
      id: 'pm.product-case-rubric',
      dimensions: [
        {
          id: 'problem-definition',
          label: '问题定义',
          weight: 0.5,
          critical: true,
          anchors: anchors(
            '没有界定问题就给方案',
            '只复述题面，范围含混',
            '目标人群与范围清楚',
            '能给出可验证的成功指标',
            '能量化机会并说明放弃项',
          ),
        },
        {
          id: 'solution-tradeoffs',
          label: '方案取舍',
          weight: 0.5,
          anchors: anchors(
            '只有一个方案且无理由',
            '罗列方案但不比较',
            '能比较主要方案优缺点',
            '能结合约束选择并说明代价',
            '能给出灰度与回退触发条件',
          ),
        },
      ],
      passThreshold: 3,
    },
    {
      id: 'pm.behavioral-rubric',
      dimensions: [
        {
          id: 'ownership',
          label: '个人贡献边界',
          weight: 0.6,
          critical: true,
          anchors: anchors(
            '分不清个人与团队',
            '能说职责但缺行动',
            '个人范围与行动清楚',
            '能说明主导决策与影响',
            '能还原冲突场景下的推动路径',
          ),
        },
        {
          id: 'reflection',
          label: '复盘',
          weight: 0.4,
          anchors: anchors(
            '识别不出问题',
            '改进停留在泛泛表述',
            '能指出具体问题与改进',
            '能说明教训如何改变后续做法',
            '能提炼可迁移原则与适用边界',
          ),
        },
      ],
      passThreshold: 3,
    },
  ],
  taskTemplates: [
    {
      id: 'pm.learn',
      label: '梳理产品方法',
      taskKind: 'learn',
      defaultMinutes: 25,
    },
    {
      id: 'pm.drill',
      label: '口头案例演练',
      taskKind: 'drill',
      defaultMinutes: 20,
      supportedFormats: [PRODUCT_MANAGEMENT_FORMAT_IDS.productCase],
    },
    {
      id: 'pm.story',
      label: '打磨行为面故事',
      taskKind: 'review',
      defaultMinutes: 15,
      supportedFormats: [PRODUCT_MANAGEMENT_FORMAT_IDS.behavioral],
    },
  ],
  navigation: [],
  capabilities: [],
  resumeModules: [],
  promptFragments: [{ slot: 'diagnosis', ref: 'diagnosis.jd' }],
  sourcePolicy: {
    preferredDomains: ['woshipm.com', 'zhihu.com'],
  },
};
