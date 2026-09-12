import type { TaskTemplate } from '@core/plugins/types';
import { EXAM_FORMS, TASK_KINDS } from '@core/enums';
import { CORE_CAPABILITIES_PACK_ID } from '@core/plugins/capabilitySuite';
import {
  SOFTWARE_ENGINEERING_FORMAT_IDS,
  formatIdForLegacyExamForm,
} from '@core/plugins/legacyRoleData';

const allFormatIds = EXAM_FORMS.map(formatIdForLegacyExamForm);

export const taskTemplates: TaskTemplate[] = [
  {
    id: 'se.learn',
    label: '学习工程考点',
    taskKind: TASK_KINDS[0],
    defaultMinutes: 30,
    supportedFormats: allFormatIds,
  },
  {
    id: 'se.drill',
    label: '口头技术演练',
    taskKind: TASK_KINDS[1],
    defaultMinutes: 15,
    supportedFormats: allFormatIds,
  },
  {
    id: 'se.read-code',
    label: '结合源码理解实现',
    taskKind: TASK_KINDS[2],
    defaultMinutes: 25,
    supportedFormats: [
      SOFTWARE_ENGINEERING_FORMAT_IDS.coding,
      SOFTWARE_ENGINEERING_FORMAT_IDS.systemDesign,
      SOFTWARE_ENGINEERING_FORMAT_IDS.projectDeepDive,
    ],
    capabilityId: CORE_CAPABILITIES_PACK_ID,
  },
  {
    id: 'se.review',
    label: '复习薄弱考点',
    taskKind: TASK_KINDS[3],
    defaultMinutes: 15,
    supportedFormats: allFormatIds,
  },
  {
    id: 'se.fallback-script',
    label: '准备技术兜底话术',
    taskKind: TASK_KINDS[4],
    defaultMinutes: 10,
    supportedFormats: allFormatIds,
  },
];
