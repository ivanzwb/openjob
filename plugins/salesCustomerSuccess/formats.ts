import type { InterviewFormatDefinition, InterviewStageTemplate } from '@core/plugins/types';
import {
  SALES_CUSTOMER_SUCCESS_FORMAT_IDS,
  SALES_CUSTOMER_SUCCESS_RUBRIC_IDS,
  SALES_ROLE_PLAY_CAPABILITY_ID,
} from './ids';

/**
 * 需要实时对话的两轮同时列出 role-play 与文本行为题。
 *
 * 顺序即优先级：宿主取第一个可用的题型。role-play 没装时这两轮退回文本行为题，
 * 蓝图仍然是四轮，权重也不变——把轮次直接删掉会让阶段权重之和不再为 1，能力
 * 诊断里的 stageWeight 会跟着失真。
 */
export const interviewStages: InterviewStageTemplate[] = [
  {
    id: 'sales.screen',
    label: '销售初筛',
    order: 0,
    formatIds: [SALES_CUSTOMER_SUCCESS_FORMAT_IDS.behavioral],
    defaultWeight: 0.2,
  },
  {
    id: 'sales.discovery-conversation',
    label: '客户对话模拟',
    order: 1,
    formatIds: [
      SALES_CUSTOMER_SUCCESS_FORMAT_IDS.customerRolePlay,
      SALES_CUSTOMER_SUCCESS_FORMAT_IDS.behavioral,
    ],
    defaultWeight: 0.3,
  },
  {
    id: 'sales.deal-review',
    label: '成交复盘面',
    order: 2,
    formatIds: [SALES_CUSTOMER_SUCCESS_FORMAT_IDS.behavioral],
    defaultWeight: 0.25,
  },
  {
    id: 'sales.negotiation-conversation',
    label: '谈判模拟',
    order: 3,
    formatIds: [
      SALES_CUSTOMER_SUCCESS_FORMAT_IDS.customerRolePlay,
      SALES_CUSTOMER_SUCCESS_FORMAT_IDS.behavioral,
    ],
    defaultWeight: 0.25,
  },
];

export const interviewFormats: InterviewFormatDefinition[] = [
  {
    id: SALES_CUSTOMER_SUCCESS_FORMAT_IDS.behavioral,
    label: '销售行为面',
    protocol: 'behavioral',
    defaultDurationMinutes: 40,
    followUpPolicy: { maxRounds: 4, strategy: 'adaptive' },
    rubricId: SALES_CUSTOMER_SUCCESS_RUBRIC_IDS.behavioral,
    // 刻意不绑 capabilityId：这是降级之后唯一还站得住的题型
  },
  {
    id: SALES_CUSTOMER_SUCCESS_FORMAT_IDS.customerRolePlay,
    label: '客户对话模拟',
    protocol: 'role-play',
    defaultDurationMinutes: 30,
    // 对话轮数比行为面多：一来一回才看得出听没听懂
    followUpPolicy: { maxRounds: 6, strategy: 'adaptive' },
    rubricId: SALES_CUSTOMER_SUCCESS_RUBRIC_IDS.rolePlay,
    capabilityId: SALES_ROLE_PLAY_CAPABILITY_ID,
  },
];
