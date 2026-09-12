import type { RubricDefinition } from '@core/plugins/types';
import { anchors } from './anchors';

export const systemDesignRubric: RubricDefinition = {
  id: 'se.system-design-rubric',
  dimensions: [
    {
      id: 'requirements-and-scale',
      label: '需求与规模澄清',
      weight: 0.2,
      anchors: anchors(
        '未澄清需求就给出方案',
        '只确认功能，忽略规模和质量目标',
        '覆盖主要功能、规模和质量目标',
        '能识别关键不确定性并建立假设',
        '能量化约束并持续用约束校验方案',
      ),
    },
    {
      id: 'architecture-and-data-flow',
      label: '架构与数据流',
      weight: 0.3,
      critical: true,
      anchors: anchors(
        '组件堆叠且数据流不成立',
        '有高层组件但职责或接口含混',
        '架构可行，关键路径清楚',
        '模块边界清晰并覆盖主要故障路径',
        '架构演进路径、控制面和数据面均清楚',
      ),
    },
    {
      id: 'scalability-and-reliability',
      label: '扩展性与可靠性',
      weight: 0.3,
      anchors: anchors(
        '未处理容量或故障',
        '只罗列缓存、队列等组件',
        '能处理主要瓶颈和单点故障',
        '覆盖降级、恢复、一致性和可观测性',
        '能量化容量并分析级联故障与恢复目标',
      ),
    },
    {
      id: 'design-tradeoffs',
      label: '设计取舍',
      weight: 0.2,
      anchors: anchors(
        '没有取舍说明',
        '只陈述方案优点',
        '能解释主要优缺点',
        '能根据业务约束选择并说明替代方案',
        '能量化成本、风险并给出演进触发条件',
      ),
    },
  ],
  passThreshold: 3,
  failConditions: ['架构与数据流为 1 分'],
};

export const projectDeepDiveRubric: RubricDefinition = {
  id: 'se.project-technical-deep-dive-rubric',
  dimensions: [
    {
      id: 'technical-ownership',
      label: '技术贡献边界',
      weight: 0.3,
      critical: true,
      anchors: anchors(
        '无法区分个人与团队工作',
        '能说负责内容但缺少具体行动',
        '个人范围、行动和产出清楚',
        '能说明主导决策及跨团队影响',
        '能完整还原责任边界和关键技术领导行为',
      ),
    },
    {
      id: 'evidence-and-results',
      label: '证据与结果',
      weight: 0.25,
      anchors: anchors(
        '关键经历与已提供材料冲突',
        '只有笼统结果，缺少验证方式',
        '结果可信且能说明验证方法',
        '有可追溯指标、基线和影响范围',
        '能解释指标因果、限制和长期结果',
      ),
    },
    {
      id: 'decision-reasoning',
      label: '决策与取舍',
      weight: 0.25,
      anchors: anchors(
        '无法解释为何采用该方案',
        '理由仅为惯例或上级要求',
        '能说明约束、候选方案和主要取舍',
        '能结合数据说明决策与调整过程',
        '能重建不确定性下的决策并分析反事实',
      ),
    },
    {
      id: 'technical-reflection',
      label: '技术复盘',
      weight: 0.2,
      anchors: anchors(
        '不能识别问题或改进点',
        '改进停留在泛泛表述',
        '能指出具体问题和下一步改进',
        '能说明教训如何改变后续工程实践',
        '能提炼可迁移原则并说明适用边界',
      ),
    },
  ],
  passThreshold: 3,
  failConditions: ['技术贡献边界为 1 分', '证据与结果为 1 分'],
};
