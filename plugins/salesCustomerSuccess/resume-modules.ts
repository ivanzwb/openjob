import type { ResumeModuleDefinition } from '@core/plugins/types';

/**
 * 插入点 D：销售 / 客户成功岗位的简历模块。
 *
 * 口径优先：业绩模块要连周期、量级、分母一起抽出来，这正是行为面评分
 * 会追问的东西；客户画像模块帮诊断判断「这张简历对过什么类型的客户」。
 */
export const resumeModules: ResumeModuleDefinition[] = [
  {
    id: 'sales.quota-performance',
    label: '业绩与完成情况',
    kind: 'list',
    schemaVersion: 1,
    evidenceKinds: ['achievement'],
    instruction:
      '抽出业绩数字与完成情况的表述，尽量保留当时的口径：周期、金额量级、完成率的分母。',
  },
  {
    id: 'sales.customer-segments',
    label: '客户画像',
    kind: 'list',
    schemaVersion: 1,
    evidenceKinds: ['experience'],
    instruction:
      '抽出候选人服务过的客户类型与行业（如「华东区制造业大客户」），以及触达过的决策层级。',
  },
];
