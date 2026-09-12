import type { CompetencyTemplate } from '@core/plugins/types';
import {
  SALES_CUSTOMER_SUCCESS_COMPETENCY_IDS,
  SALES_CUSTOMER_SUCCESS_FORMAT_IDS,
} from './ids';

/**
 * 五项能力覆盖成交全流程，默认权重之和为 1。
 *
 * 每一项的 supportedFormats 都至少包含文本行为题：没装角色扮演插件时，五项能力
 * 仍然都有地方可练、可考。
 */
export const competencyTemplates: CompetencyTemplate[] = [
  {
    id: SALES_CUSTOMER_SUCCESS_COMPETENCY_IDS.discovery,
    name: '客户诊断与需求挖掘',
    category: 'skill',
    description: '通过提问和倾听搞清客户的真实处境、决策链与不采购的后果',
    defaultWeight: 0.22,
    levelIndicators: [
      { level: 1, behavior: '照着话术念，客户说什么都接不上' },
      { level: 3, behavior: '能问出预算、决策人和当前替代方案' },
      { level: 5, behavior: '能挖到客户自己还没说清的诉求，并识别决策链上的隐性反对者' },
    ],
    evidenceKinds: ['experience', 'skill', 'behavior'],
    supportedFormats: [
      SALES_CUSTOMER_SUCCESS_FORMAT_IDS.behavioral,
      SALES_CUSTOMER_SUCCESS_FORMAT_IDS.customerRolePlay,
    ],
  },
  {
    id: SALES_CUSTOMER_SUCCESS_COMPETENCY_IDS.valueArticulation,
    name: '价值表达与方案匹配',
    category: 'skill',
    description: '把产品能力翻译成客户自己的衡量标准和业务收益',
    defaultWeight: 0.2,
    levelIndicators: [
      { level: 1, behavior: '只罗列功能，说不出对客户的意义' },
      { level: 3, behavior: '能把主要能力对应到客户的业务收益' },
      { level: 5, behavior: '能按不同角色（使用者、预算方、反对者）分别组织价值口径' },
    ],
    evidenceKinds: ['experience', 'achievement', 'skill'],
    supportedFormats: [
      SALES_CUSTOMER_SUCCESS_FORMAT_IDS.behavioral,
      SALES_CUSTOMER_SUCCESS_FORMAT_IDS.customerRolePlay,
    ],
  },
  {
    id: SALES_CUSTOMER_SUCCESS_COMPETENCY_IDS.objectionHandling,
    name: '异议处理与信任建立',
    category: 'behavior',
    description: '面对质疑、比价和拖延时保持推进，同时不损耗长期信任',
    defaultWeight: 0.2,
    levelIndicators: [
      { level: 1, behavior: '被质疑就让价或回避' },
      { level: 3, behavior: '能复述顾虑并给出针对性回应' },
      { level: 5, behavior: '能分辨真异议与借口，用第三方证据或试点方案化解' },
    ],
    evidenceKinds: ['behavior', 'experience'],
    supportedFormats: [
      SALES_CUSTOMER_SUCCESS_FORMAT_IDS.behavioral,
      SALES_CUSTOMER_SUCCESS_FORMAT_IDS.customerRolePlay,
    ],
  },
  {
    id: SALES_CUSTOMER_SUCCESS_COMPETENCY_IDS.negotiation,
    name: '商务谈判与成交推进',
    category: 'skill',
    description: '在条款、价格和交付范围之间取舍，把客户推进到明确的下一步',
    defaultWeight: 0.18,
    levelIndicators: [
      { level: 1, behavior: '把谈判等同于报价，谈不到条款' },
      { level: 3, behavior: '能守住底线并换取对等条件' },
      { level: 5, behavior: '能设计让步顺序，用交付范围和周期换取价格与条款' },
    ],
    evidenceKinds: ['experience', 'achievement', 'behavior'],
    supportedFormats: [
      SALES_CUSTOMER_SUCCESS_FORMAT_IDS.behavioral,
      SALES_CUSTOMER_SUCCESS_FORMAT_IDS.customerRolePlay,
    ],
  },
  {
    id: SALES_CUSTOMER_SUCCESS_COMPETENCY_IDS.pipeline,
    name: '管道管理与预测',
    category: 'experience',
    description: '按阶段管理机会、判断真实成交概率并给出可信预测',
    defaultWeight: 0.2,
    levelIndicators: [
      { level: 1, behavior: '只按感觉判断单子进展' },
      { level: 3, behavior: '能按阶段标准判断机会真实性并解释依据' },
      { level: 5, behavior: '能解释预测偏差来源，并说明如何据此调整投入' },
    ],
    evidenceKinds: ['experience', 'achievement'],
    // 管道管理靠复盘历史机会来考，实时对话里问不出预测口径
    supportedFormats: [SALES_CUSTOMER_SUCCESS_FORMAT_IDS.behavioral],
  },
];
