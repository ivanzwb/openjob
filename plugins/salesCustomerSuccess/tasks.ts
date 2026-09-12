import type { TaskTemplate } from '@core/plugins/types';
import type { TaskKind } from '@core/enums';
import { SALES_CUSTOMER_SUCCESS_FORMAT_IDS } from './ids';

const TASK_KIND = {
  learn: 'learn',
  drill: 'drill',
  review: 'review',
  fallbackScript: 'fallbackScript',
} as const satisfies Record<string, TaskKind>;

const allFormatIds = Object.values(SALES_CUSTOMER_SUCCESS_FORMAT_IDS);

/**
 * 四条任务模板都不挂 capabilityId。
 *
 * 准备成本因此与插件是否安装无关：没装角色扮演的用户也拿得到完整的每日计划，
 * 只是练的时候用文本行为题。
 */
export const taskTemplates: TaskTemplate[] = [
  {
    id: 'sales.learn',
    label: '梳理成交流程与提问清单',
    taskKind: TASK_KIND.learn,
    defaultMinutes: 25,
    supportedFormats: allFormatIds,
  },
  {
    id: 'sales.drill',
    label: '口头客户对话演练',
    taskKind: TASK_KIND.drill,
    defaultMinutes: 20,
    supportedFormats: allFormatIds,
  },
  {
    id: 'sales.review',
    label: '复盘薄弱销售能力',
    taskKind: TASK_KIND.review,
    defaultMinutes: 15,
    supportedFormats: allFormatIds,
  },
  {
    id: 'sales.fallback-script',
    label: '准备异议与比价兜底话术',
    taskKind: TASK_KIND.fallbackScript,
    defaultMinutes: 10,
    supportedFormats: allFormatIds,
  },
];
