import type { CompetencyTemplate } from '@core/plugins/types';
import { PRODUCT_MANAGER_COMPETENCY_IDS, PRODUCT_MANAGER_FORMAT_IDS } from './ids';

export const competencyTemplates: CompetencyTemplate[] = [
  {
    id: PRODUCT_MANAGER_COMPETENCY_IDS.problemFraming,
    name: '问题定义与机会判断',
    category: 'skill',
    description: '把模糊诉求收敛成可判断的目标、范围和值得做的理由',
    defaultWeight: 0.22,
    levelIndicators: [
      { level: 1, behavior: '直接跳到方案，说不清要解决谁的什么问题' },
      { level: 3, behavior: '能界定目标人群、范围和判断成败的依据' },
      { level: 5, behavior: '能估算机会大小，并说明主动放弃了哪些方向及理由' },
    ],
    evidenceKinds: ['experience', 'achievement'],
    supportedFormats: [
      PRODUCT_MANAGER_FORMAT_IDS.productCase,
      PRODUCT_MANAGER_FORMAT_IDS.presentation,
    ],
  },
  {
    id: PRODUCT_MANAGER_COMPETENCY_IDS.userInsight,
    name: '用户洞察与调研',
    category: 'knowledge',
    description: '通过访谈、行为数据和竞品分析得到可行动的用户结论',
    defaultWeight: 0.2,
    levelIndicators: [
      { level: 1, behavior: '只凭个人直觉替用户做判断' },
      { level: 3, behavior: '能设计调研并归纳出可行动的结论' },
      { level: 5, behavior: '能交叉验证定性与定量结论，并预判样本与提问方式带来的偏差' },
    ],
    evidenceKinds: ['experience', 'achievement', 'skill'],
    supportedFormats: [
      PRODUCT_MANAGER_FORMAT_IDS.productCase,
      PRODUCT_MANAGER_FORMAT_IDS.behavioral,
    ],
  },
  {
    id: PRODUCT_MANAGER_COMPETENCY_IDS.metrics,
    name: '指标设计与验证',
    category: 'skill',
    description: '定义口径清晰的成功指标，并用实验或观测验证产品判断',
    defaultWeight: 0.2,
    levelIndicators: [
      { level: 1, behavior: '只会引用通用指标，说不出口径和适用场景' },
      { level: 3, behavior: '能为目标选出主指标与护栏指标，并说明口径' },
      { level: 5, behavior: '能设计实验、识别指标被操纵的路径并解释因果限制' },
    ],
    evidenceKinds: ['experience', 'achievement', 'skill'],
    supportedFormats: [
      PRODUCT_MANAGER_FORMAT_IDS.productCase,
      PRODUCT_MANAGER_FORMAT_IDS.presentation,
    ],
  },
  {
    id: PRODUCT_MANAGER_COMPETENCY_IDS.prioritization,
    name: '优先级与资源取舍',
    category: 'skill',
    description: '在资源、时间和依赖约束下决定做什么、不做什么和先后顺序',
    defaultWeight: 0.18,
    levelIndicators: [
      { level: 1, behavior: '把所有需求都列为重要，排不出先后' },
      { level: 3, behavior: '能用一致的标准排出顺序并说明依据' },
      { level: 5, behavior: '能量化收益与代价，说明依赖关系和顺序调整的触发条件' },
    ],
    evidenceKinds: ['experience', 'achievement', 'behavior'],
    supportedFormats: [
      PRODUCT_MANAGER_FORMAT_IDS.productCase,
      PRODUCT_MANAGER_FORMAT_IDS.behavioral,
    ],
  },
  {
    id: PRODUCT_MANAGER_COMPETENCY_IDS.productDecision,
    name: '产品决策与跨职能推动',
    category: 'behavior',
    description: '在信息不足和意见不一致时做出决策，并推动研发、设计与业务落地',
    defaultWeight: 0.2,
    levelIndicators: [
      { level: 1, behavior: '只能转述他人意见，推不动一次明确决策' },
      { level: 3, behavior: '能说明分歧点并促成一次可执行的决策' },
      { level: 5, behavior: '能还原高压场景下的决策依据、推动路径和事后校正' },
    ],
    evidenceKinds: ['behavior', 'experience', 'achievement'],
    supportedFormats: [
      PRODUCT_MANAGER_FORMAT_IDS.behavioral,
      PRODUCT_MANAGER_FORMAT_IDS.presentation,
    ],
  },
];
