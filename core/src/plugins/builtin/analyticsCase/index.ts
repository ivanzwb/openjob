/**
 * analytics-case 能力插件：表格数据案例分析。
 *
 * 提供两样东西，都是声明式的：
 * - `tabular-dataset` artifact 契约，让真实 CSV/XLSX 能被读成受控的表格；
 * - 数据案例的作答结构与落地校验（概览/指标/假设/建议/风险）。
 *
 * 边界：
 * - 插件只声明 artifact 类型与结构，解析由 Core 按 `artifact:read` 授权后执行，
 *   插件拿不到文件句柄、数据库和 API Key；
 * - 产品岗把它当**可选**依赖：装了能上真实表格，没装时纯文字案例照样完整可跑
 *   （见 productManager 的 golden 测试），所以这里不注册任何题型或 Prompt 片段。
 */

import type { CapabilityPlugin } from '../../types';
import {
  TABULAR_DATASET_ARTIFACT_TYPE,
  TABULAR_DATASET_SCHEMA_VERSION,
} from './dataset';

export const ANALYTICS_CASE_CAPABILITY_ID = 'analytics-case';
export const ANALYTICS_CASE_CAPABILITY_VERSION = '1.0.0';

export * from './dataset';
export * from './analysis';

/** 案例作答要覆盖的五个部分；与 AnalyticsCaseAnalysis 的字段一一对应。 */
export const ANALYTICS_CASE_DELIVERABLES = [
  { id: 'overview', label: '数据概览' },
  { id: 'metrics', label: '指标分析' },
  { id: 'hypotheses', label: '假设' },
  { id: 'recommendations', label: '建议' },
  { id: 'risks', label: '风险' },
] as const;

export interface AnalyticsCaseScenario {
  id: string;
  title: string;
  /** 业务背景与要回答的问题。 */
  brief: string;
  /** 内置样例数据，保证没有用户文件时也能出题。 */
  sampleCsv: string;
  /** 这道题期望候选人重点看的列。 */
  focusColumns: string[];
}

export const ANALYTICS_CASE_SCENARIOS: readonly AnalyticsCaseScenario[] = [
  {
    id: 'activation-drop',
    title: '新用户激活率下滑',
    brief:
      '过去六周新注册用户的激活率持续下滑，增长团队认为是渠道质量问题，产品团队认为是新引导流程的问题。请先描述数据，再给出你的判断与下一步。',
    sampleCsv: [
      'week,channel,signups,activated,onboarding_variant',
      '2025-06-02,paid-search,1240,486,legacy',
      '2025-06-02,organic,880,401,legacy',
      '2025-06-09,paid-search,1310,498,legacy',
      '2025-06-09,organic,905,414,legacy',
      '2025-06-16,paid-search,1288,404,new',
      '2025-06-16,organic,893,352,new',
      '2025-06-23,paid-search,1352,398,new',
      '2025-06-23,organic,912,349,new',
      '2025-06-30,paid-search,1401,392,new',
      '2025-06-30,organic,934,344,new',
      '2025-07-07,paid-search,1377,381,new',
      '2025-07-07,organic,921,338,new',
    ].join('\n'),
    focusColumns: ['signups', 'activated', 'onboarding_variant'],
  },
  {
    id: 'support-cost',
    title: '客服工单成本上升',
    brief:
      '客服成本环比上升，但客户满意度没有变化。请判断成本上升来自哪里，并说明你会建议削减还是保留。',
    sampleCsv: [
      'month,category,tickets,avg_handle_minutes,csat,escalated',
      '2025-03-01,billing,2140,11.2,4.3,no',
      '2025-03-01,integration,860,28.4,4.1,yes',
      '2025-03-01,how-to,3320,6.1,4.5,no',
      '2025-04-01,billing,2210,11.5,4.3,no',
      '2025-04-01,integration,1105,31.7,4.0,yes',
      '2025-04-01,how-to,3280,6.3,4.5,no',
      '2025-05-01,billing,2185,11.1,4.4,no',
      '2025-05-01,integration,1402,34.9,4.1,yes',
      '2025-05-01,how-to,3301,6.2,4.5,no',
    ].join('\n'),
    focusColumns: ['tickets', 'avg_handle_minutes', 'category'],
  },
];

export const analyticsCaseCapabilityPlugin: CapabilityPlugin = {
  manifest: {
    id: ANALYTICS_CASE_CAPABILITY_ID,
    version: ANALYTICS_CASE_CAPABILITY_VERSION,
    type: 'capability',
    displayName: 'Analytics Case',
    description: '表格数据案例分析：CSV/XLSX 读入受控表格，作答需落在真实列上。',
    compatibility: {
      core: '^1.0.0',
      schema: 23,
    },
    // 只要读 artifact：解析与文件访问都由 Core 网关代劳。
    permissions: ['artifact:read'],
    runtime: {
      desktop: 'full',
      // 手机端没有文件选择与表格读入，只能查看已同步的分析结果。
      mobile: 'view-only',
    },
    artifactSchemas: {
      [TABULAR_DATASET_ARTIFACT_TYPE]: TABULAR_DATASET_SCHEMA_VERSION,
    },
  },
  register(registry) {
    registry.registerArtifactParser({
      artifactType: TABULAR_DATASET_ARTIFACT_TYPE,
      schemaVersion: TABULAR_DATASET_SCHEMA_VERSION,
      permission: 'artifact:read',
    });
  },
};
