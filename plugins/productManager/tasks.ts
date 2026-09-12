import type { TaskTemplate } from '@core/plugins/types';
import type { TaskKind } from '@core/enums';
import { PRODUCT_MANAGER_FORMAT_IDS } from './ids';

const TASK_KIND = {
  learn: 'learn',
  drill: 'drill',
  review: 'review',
  fallbackScript: 'fallbackScript',
} as const satisfies Record<string, TaskKind>;

const allFormatIds = Object.values(PRODUCT_MANAGER_FORMAT_IDS);

export const taskTemplates: TaskTemplate[] = [
  {
    id: 'pm.learn',
    label: '梳理产品方法与判断口径',
    taskKind: TASK_KIND.learn,
    defaultMinutes: 25,
    supportedFormats: allFormatIds,
  },
  {
    id: 'pm.drill',
    label: '口头产品演练',
    taskKind: TASK_KIND.drill,
    defaultMinutes: 20,
    supportedFormats: allFormatIds,
  },
  {
    id: 'pm.review',
    label: '复习薄弱产品能力',
    taskKind: TASK_KIND.review,
    defaultMinutes: 15,
    supportedFormats: allFormatIds,
  },
  {
    id: 'pm.fallback-script',
    label: '准备产品兜底话术',
    taskKind: TASK_KIND.fallbackScript,
    defaultMinutes: 10,
    supportedFormats: allFormatIds,
  },
];
