/**
 * 数据案例的作答结构：概览、指标分析、假设、建议、风险。
 *
 * 这里定的不是「答案长什么样」，而是**答案必须挂在什么上面**：
 * - 指标分析必须指名它依据哪几列，列名必须在 artifact 里真实存在；
 * - 假设必须挂在指标观察上，不能凭空提出；
 * - 建议必须挂在假设上，不能跳过推理直接给动作；
 * - 数据本身有局限（被截断、缺失率高）时，风险里必须承认这件事。
 *
 * 这几条是数据岗面试真正的评分点，也是把「像分析」和「是分析」区分开的地方。
 * 校验放在 shared，桌面与手机看到的是同一套判断。
 */

import type { TabularColumnType, TabularDataset } from './dataset';

/** 缺失率超过这个比例，就算已知的数据质量局限，必须在风险里提。 */
export const HIGH_MISSING_RATE = 0.2;

export interface DatasetColumnOverview {
  name: string;
  type: TabularColumnType;
  /** 0–1，按实际读入的行数算。 */
  missingRate: number;
}

export interface DatasetOverview {
  /** 实际读入的行数。 */
  rowCount: number;
  /** 文件里的真实行数；与 rowCount 不同即说明被截断。 */
  totalRows: number;
  truncated: boolean;
  truncatedCells: number;
  columns: DatasetColumnOverview[];
}

/** 从 artifact 直接算出概览；这一段不经过模型，保证概览永远是事实。 */
export function describeDataset(dataset: TabularDataset): DatasetOverview {
  const rowCount = dataset.rows.length;
  return {
    rowCount,
    totalRows: dataset.totalRows,
    truncated: dataset.truncated,
    truncatedCells: dataset.truncatedCells,
    columns: dataset.columns.map((column) => ({
      name: column.name,
      type: column.type,
      missingRate: rowCount === 0 ? 0 : column.missingCount / rowCount,
    })),
  };
}

/** 概览里已经暴露出来的数据局限。 */
export function datasetLimitations(overview: DatasetOverview): string[] {
  const limitations: string[] = [];
  if (overview.truncated) {
    limitations.push(`只读入前 ${overview.rowCount} 行，文件共 ${overview.totalRows} 行`);
  }
  if (overview.truncatedCells > 0) {
    limitations.push(`${overview.truncatedCells} 个单元格因过长被截短`);
  }
  for (const column of overview.columns) {
    if (column.missingRate > HIGH_MISSING_RATE) {
      limitations.push(`列 ${column.name} 缺失率 ${Math.round(column.missingRate * 100)}%`);
    }
  }
  return limitations;
}

export interface MetricFinding {
  id: string;
  /** 指标名，例如「周活跃留存」。 */
  metric: string;
  /** 依据的列名，必须在 artifact 里存在。 */
  columns: string[];
  /** 观察到的现象。 */
  observation: string;
  /** 量化结果；可能是「环比 -12%」这类表述，所以是文本而非数字。 */
  value?: string;
}

export interface CaseHypothesis {
  id: string;
  statement: string;
  /** 支撑它的 MetricFinding id。 */
  supportedBy: string[];
  /** 怎么验证它。缺了这条，假设就只是猜测。 */
  validation: string;
}

export interface CaseRecommendation {
  id: string;
  action: string;
  /** 基于哪些 CaseHypothesis id。 */
  basedOn: string[];
  expectedImpact: string;
}

export const CASE_RISK_KINDS = [
  'data-quality',
  'causal-inference',
  'execution',
  'external',
] as const;
export type CaseRiskKind = (typeof CASE_RISK_KINDS)[number];

export interface CaseRisk {
  id: string;
  kind: CaseRiskKind;
  description: string;
  mitigation: string;
}

export interface AnalyticsCaseAnalysis {
  overview: DatasetOverview;
  metrics: MetricFinding[];
  hypotheses: CaseHypothesis[];
  recommendations: CaseRecommendation[];
  risks: CaseRisk[];
}

export type AnalysisIssueCode =
  | 'invalid-value'
  | 'duplicate-id'
  | 'unknown-column'
  | 'missing-reference'
  | 'empty-section'
  | 'unacknowledged-limitation';

export interface AnalysisIssue {
  path: string;
  code: AnalysisIssueCode;
  message: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function collectIds(
  issues: AnalysisIssue[],
  items: readonly { id: string }[],
  path: string,
): Set<string> {
  const ids = new Set<string>();
  items.forEach((item, index) => {
    if (!isNonEmptyString(item.id)) {
      issues.push({ path: `${path}[${index}].id`, code: 'invalid-value', message: 'id 不能为空' });
      return;
    }
    if (ids.has(item.id)) {
      issues.push({
        path: `${path}[${index}].id`,
        code: 'duplicate-id',
        message: `id ${item.id} 重复`,
      });
      return;
    }
    ids.add(item.id);
  });
  return ids;
}

/**
 * 校验一份作答是否真的落在数据上。
 *
 * 返回空数组表示通过。这里不评价分析水平高低——那是 Rubric 的事——只拦
 * 结构性造假：引用不存在的列、悬空的假设、跳过推理的建议、隐瞒的数据局限。
 */
export function validateAnalyticsCaseAnalysis(
  analysis: AnalyticsCaseAnalysis,
  dataset: TabularDataset,
): AnalysisIssue[] {
  const issues: AnalysisIssue[] = [];
  const columnNames = new Set(dataset.columns.map((column) => column.name));

  const sections: [keyof AnalyticsCaseAnalysis, readonly unknown[]][] = [
    ['metrics', analysis.metrics],
    ['hypotheses', analysis.hypotheses],
    ['recommendations', analysis.recommendations],
    ['risks', analysis.risks],
  ];
  for (const [name, items] of sections) {
    if (items.length === 0) {
      issues.push({
        path: String(name),
        code: 'empty-section',
        message: `${String(name)} 不能为空`,
      });
    }
  }

  const metricIds = collectIds(issues, analysis.metrics, 'metrics');
  analysis.metrics.forEach((metric, index) => {
    const path = `metrics[${index}]`;
    if (!isNonEmptyString(metric.metric)) {
      issues.push({ path: `${path}.metric`, code: 'invalid-value', message: '指标名不能为空' });
    }
    if (!isNonEmptyString(metric.observation)) {
      issues.push({ path: `${path}.observation`, code: 'invalid-value', message: '观察不能为空' });
    }
    if (metric.columns.length === 0) {
      issues.push({
        path: `${path}.columns`,
        code: 'invalid-value',
        message: '指标必须指明依据的列',
      });
    }
    metric.columns.forEach((column, columnIndex) => {
      if (!columnNames.has(column)) {
        // 造一列不存在的数据是这类作答最常见也最致命的失败。
        issues.push({
          path: `${path}.columns[${columnIndex}]`,
          code: 'unknown-column',
          message: `数据里没有列 ${column}`,
        });
      }
    });
  });

  const hypothesisIds = collectIds(issues, analysis.hypotheses, 'hypotheses');
  analysis.hypotheses.forEach((hypothesis, index) => {
    const path = `hypotheses[${index}]`;
    if (!isNonEmptyString(hypothesis.statement)) {
      issues.push({ path: `${path}.statement`, code: 'invalid-value', message: '假设不能为空' });
    }
    if (!isNonEmptyString(hypothesis.validation)) {
      issues.push({
        path: `${path}.validation`,
        code: 'invalid-value',
        message: '假设必须说明如何验证',
      });
    }
    if (hypothesis.supportedBy.length === 0) {
      issues.push({
        path: `${path}.supportedBy`,
        code: 'invalid-value',
        message: '假设必须挂在至少一条指标观察上',
      });
    }
    hypothesis.supportedBy.forEach((metricId, refIndex) => {
      if (!metricIds.has(metricId)) {
        issues.push({
          path: `${path}.supportedBy[${refIndex}]`,
          code: 'missing-reference',
          message: `找不到指标观察 ${metricId}`,
        });
      }
    });
  });

  analysis.recommendations.forEach((recommendation, index) => {
    const path = `recommendations[${index}]`;
    if (!isNonEmptyString(recommendation.action)) {
      issues.push({ path: `${path}.action`, code: 'invalid-value', message: '建议不能为空' });
    }
    if (!isNonEmptyString(recommendation.expectedImpact)) {
      issues.push({
        path: `${path}.expectedImpact`,
        code: 'invalid-value',
        message: '建议必须说明预期影响',
      });
    }
    if (recommendation.basedOn.length === 0) {
      issues.push({
        path: `${path}.basedOn`,
        code: 'invalid-value',
        message: '建议必须挂在至少一条假设上',
      });
    }
    recommendation.basedOn.forEach((hypothesisId, refIndex) => {
      if (!hypothesisIds.has(hypothesisId)) {
        issues.push({
          path: `${path}.basedOn[${refIndex}]`,
          code: 'missing-reference',
          message: `找不到假设 ${hypothesisId}`,
        });
      }
    });
  });

  collectIds(issues, analysis.risks, 'risks');
  analysis.risks.forEach((risk, index) => {
    const path = `risks[${index}]`;
    if (!(CASE_RISK_KINDS as readonly string[]).includes(risk.kind)) {
      issues.push({ path: `${path}.kind`, code: 'invalid-value', message: `未知风险类型 ${risk.kind}` });
    }
    if (!isNonEmptyString(risk.description)) {
      issues.push({ path: `${path}.description`, code: 'invalid-value', message: '风险描述不能为空' });
    }
    if (!isNonEmptyString(risk.mitigation)) {
      issues.push({
        path: `${path}.mitigation`,
        code: 'invalid-value',
        message: '风险必须给出应对',
      });
    }
  });

  const limitations = datasetLimitations(analysis.overview);
  if (limitations.length > 0 && !analysis.risks.some((risk) => risk.kind === 'data-quality')) {
    // 数据摆明有局限却一条不提，是在拿一份自己都不相信的结论下建议。
    issues.push({
      path: 'risks',
      code: 'unacknowledged-limitation',
      message: `数据存在已知局限（${limitations.join('；')}），风险里必须有 data-quality 一项`,
    });
  }

  return issues;
}
