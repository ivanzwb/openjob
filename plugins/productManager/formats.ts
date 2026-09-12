import type { InterviewFormatDefinition, InterviewStageTemplate } from '@core/plugins/types';
import { PRODUCT_MANAGER_FORMAT_IDS, PRODUCT_MANAGER_RUBRIC_IDS } from './ids';

export const interviewStages: InterviewStageTemplate[] = [
  {
    id: 'pm.product-screen',
    label: '产品初筛',
    order: 0,
    formatIds: [PRODUCT_MANAGER_FORMAT_IDS.behavioral],
    defaultWeight: 0.2,
  },
  {
    id: 'pm.product-case-interview',
    label: '产品案例面',
    order: 1,
    formatIds: [PRODUCT_MANAGER_FORMAT_IDS.productCase],
    defaultWeight: 0.4,
  },
  {
    id: 'pm.cross-functional-interview',
    label: '跨职能协作面',
    order: 2,
    formatIds: [PRODUCT_MANAGER_FORMAT_IDS.behavioral],
    defaultWeight: 0.2,
  },
  {
    id: 'pm.final-presentation',
    label: '终面产品陈述',
    order: 3,
    formatIds: [PRODUCT_MANAGER_FORMAT_IDS.presentation],
    defaultWeight: 0.2,
  },
];

export const interviewFormats: InterviewFormatDefinition[] = [
  {
    id: PRODUCT_MANAGER_FORMAT_IDS.productCase,
    label: '产品案例',
    protocol: 'case',
    defaultDurationMinutes: 45,
    followUpPolicy: { maxRounds: 3, strategy: 'adaptive' },
    rubricId: PRODUCT_MANAGER_RUBRIC_IDS.productCase,
    // 刻意不绑 capabilityId：analytics-case 只是加强项，纯文本案例必须独立成立
  },
  {
    id: PRODUCT_MANAGER_FORMAT_IDS.behavioral,
    label: '产品行为面',
    protocol: 'behavioral',
    defaultDurationMinutes: 35,
    followUpPolicy: { maxRounds: 4, strategy: 'adaptive' },
    rubricId: PRODUCT_MANAGER_RUBRIC_IDS.behavioral,
  },
  {
    id: PRODUCT_MANAGER_FORMAT_IDS.presentation,
    label: '产品陈述',
    protocol: 'presentation',
    defaultDurationMinutes: 30,
    followUpPolicy: { maxRounds: 2, strategy: 'adaptive' },
    rubricId: PRODUCT_MANAGER_RUBRIC_IDS.presentation,
  },
];
