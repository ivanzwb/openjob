import type { InterviewFormatDefinition, InterviewStageTemplate } from '@core/plugins/types';
import { SOFTWARE_ENGINEERING_FORMAT_IDS } from '@core/plugins/legacyRoleData';

export const interviewFormats: InterviewFormatDefinition[] = [
  {
    id: SOFTWARE_ENGINEERING_FORMAT_IDS.knowledge,
    label: '技术知识问答',
    protocol: 'knowledge',
    defaultDurationMinutes: 30,
    followUpPolicy: { maxRounds: 3, strategy: 'adaptive' },
    rubricId: 'se.technical-knowledge-rubric',
  },
  {
    id: SOFTWARE_ENGINEERING_FORMAT_IDS.coding,
    label: '编码与算法',
    protocol: 'coding',
    defaultDurationMinutes: 45,
    followUpPolicy: { maxRounds: 2, strategy: 'adaptive' },
    rubricId: 'se.coding-rubric',
  },
  {
    id: SOFTWARE_ENGINEERING_FORMAT_IDS.systemDesign,
    label: '系统设计',
    protocol: 'case',
    defaultDurationMinutes: 45,
    followUpPolicy: { maxRounds: 3, strategy: 'adaptive' },
    rubricId: 'se.system-design-rubric',
  },
  {
    id: SOFTWARE_ENGINEERING_FORMAT_IDS.projectDeepDive,
    label: '项目技术深挖',
    protocol: 'behavioral',
    defaultDurationMinutes: 40,
    followUpPolicy: { maxRounds: 4, strategy: 'adaptive' },
    rubricId: 'se.project-technical-deep-dive-rubric',
  },
];

export const interviewStages: InterviewStageTemplate[] = [
  {
    id: 'se.technical-screen',
    label: '技术筛选',
    order: 0,
    formatIds: [SOFTWARE_ENGINEERING_FORMAT_IDS.knowledge],
    defaultWeight: 0.2,
  },
  {
    id: 'se.coding-interview',
    label: '编码面试',
    order: 1,
    formatIds: [SOFTWARE_ENGINEERING_FORMAT_IDS.coding],
    defaultWeight: 0.3,
  },
  {
    id: 'se.system-design-interview',
    label: '系统设计面试',
    order: 2,
    formatIds: [SOFTWARE_ENGINEERING_FORMAT_IDS.systemDesign],
    defaultWeight: 0.3,
  },
  {
    id: 'se.project-technical-interview',
    label: '项目技术面',
    order: 3,
    formatIds: [SOFTWARE_ENGINEERING_FORMAT_IDS.projectDeepDive],
    defaultWeight: 0.2,
  },
];
