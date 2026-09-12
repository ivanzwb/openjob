import type { RubricDefinition } from '@core/plugins/types';
import { anchors } from './anchors';
import { PRODUCT_MANAGER_RUBRIC_IDS } from '../ids';

/**
 * 维度刻意与工程设计量规不重叠。
 *
 * 工程设计看的是架构、数据流、扩展性与可靠性；产品案例看的是问题定义、洞察、
 * 取舍和指标验证。两套维度同名会让跨岗位的历史评分被放在一起比较，而它们衡量
 * 的根本不是同一件事。
 */
export const productCaseRubric: RubricDefinition = {
  id: PRODUCT_MANAGER_RUBRIC_IDS.productCase,
  dimensions: [
    {
      id: 'problem-definition',
      label: '问题定义与目标',
      weight: 0.3,
      critical: true,
      anchors: anchors(
        '没有界定问题就开始给方案',
        '只复述题面，目标人群和范围含混',
        '目标人群、范围和判断依据清楚',
        '能识别关键不确定性并建立明确假设',
        '能估算机会大小并说明放弃项及理由',
      ),
    },
    {
      id: 'user-and-market-insight',
      label: '用户与市场洞察',
      weight: 0.2,
      anchors: anchors(
        '用个人偏好代替用户诉求',
        '有洞察但与题干场景无关',
        '能给出与场景相关的用户结论',
        '能说明结论从哪类证据推出',
        '能交叉验证多来源并指出结论的偏差风险',
      ),
    },
    {
      id: 'solution-and-prioritization',
      label: '方案与优先级',
      weight: 0.25,
      anchors: anchors(
        '只有一个方案且没有理由',
        '罗列多个方案但不比较',
        '能比较主要方案的收益与代价',
        '能按一致标准排序并说明依赖关系',
        '能量化取舍并给出顺序调整的触发条件',
      ),
    },
    {
      id: 'success-metrics',
      label: '成功指标与验证',
      weight: 0.25,
      anchors: anchors(
        '没有提出任何衡量方式',
        '只给通用指标，说不出口径',
        '主指标与目标一致且口径清楚',
        '能配套护栏指标并说明验证方式',
        '能设计实验、预判指标失真并解释因果限制',
      ),
    },
  ],
  passThreshold: 3,
  failConditions: ['问题定义与目标为 1 分'],
};

export const behavioralRubric: RubricDefinition = {
  id: PRODUCT_MANAGER_RUBRIC_IDS.behavioral,
  dimensions: [
    {
      id: 'ownership-and-influence',
      label: '个人贡献与推动',
      weight: 0.35,
      critical: true,
      anchors: anchors(
        '分不清个人与团队做了什么',
        '能说职责但缺少具体动作',
        '个人范围、动作和产出清楚',
        '能说明主导的决策及其影响范围',
        '能还原意见不一致时的推动路径和代价',
      ),
    },
    {
      id: 'stakeholder-communication',
      label: '跨职能沟通',
      weight: 0.25,
      anchors: anchors(
        '只从自己视角叙述',
        '能说出他人立场但不影响自己判断',
        '能说明分歧点和各方关注',
        '能针对不同对象调整表达并达成一致',
        '能重建对齐过程，并说明留下了什么机制',
      ),
    },
    {
      id: 'product-judgment',
      label: '产品判断依据',
      weight: 0.2,
      anchors: anchors(
        '说不出当时为什么这么定',
        '理由仅为惯例或上级要求',
        '能说明约束、候选项和主要取舍',
        '能结合数据与用户证据说明决策',
        '能还原信息不足下的判断并分析反事实',
      ),
    },
    {
      id: 'outcome-reflection',
      label: '结果与复盘',
      weight: 0.2,
      anchors: anchors(
        '关键经历与已提供材料不一致',
        '只有笼统结果，说不清怎么验证',
        '结果可信且能说明验证方式',
        '能指出判断偏差和后续改进',
        '能提炼可迁移原则并说明适用边界',
      ),
    },
  ],
  passThreshold: 3,
  failConditions: ['个人贡献与推动为 1 分', '结果与复盘为 1 分'],
};

export const presentationRubric: RubricDefinition = {
  id: PRODUCT_MANAGER_RUBRIC_IDS.presentation,
  dimensions: [
    {
      id: 'narrative-structure',
      label: '结构与结论先行',
      weight: 0.3,
      critical: true,
      anchors: anchors(
        '没有结论，听完不知道要决定什么',
        '结论埋在最后，铺垫过长',
        '开场给出结论，主线清楚',
        '每一段都在支撑要请听众做的决定',
        '结构紧凑，能按时间与听众反应临场调整',
      ),
    },
    {
      id: 'audience-adaptation',
      label: '听众适配',
      weight: 0.25,
      anchors: anchors(
        '不区分听众，一套说法讲到底',
        '知道听众不同但表达没有变化',
        '按听众关注点选择内容与措辞',
        '能预判听众顾虑并提前回应',
        '能同时照顾多方关注并推动当场决策',
      ),
    },
    {
      id: 'evidence-and-visuals',
      label: '论据与呈现',
      weight: 0.25,
      anchors: anchors(
        '论据与结论对不上',
        '堆砌数据但不解释含义',
        '关键结论都有对应论据',
        '论据精简有力，口径清楚',
        '能用一条主线串起证据并主动交代不确定性',
      ),
    },
    {
      id: 'qa-handling',
      label: '质疑应对',
      weight: 0.2,
      anchors: anchors(
        '回避质疑或答非所问',
        '被追问后放弃原判断',
        '能正面回应主要质疑',
        '能区分口径问题与判断问题分别回应',
        '能当场吸收有效反对意见并给出修正后的建议',
      ),
    },
  ],
  passThreshold: 3,
  failConditions: ['结构与结论先行为 1 分'],
};
