/**
 * 数据案例作答的落地校验。
 *
 * 这里只拦结构性造假——引用不存在的列、悬空的假设、跳过推理的建议、
 * 隐瞒的数据局限。分析水平高低归 Rubric，不归这里。
 */
import { describe, expect, it } from 'vitest';

import {
  HIGH_MISSING_RATE,
  datasetLimitations,
  describeDataset,
  validateAnalyticsCaseAnalysis,
  type AnalyticsCaseAnalysis,
  type CaseRisk,
} from './analysis';
import { TABULAR_DATASET_LIMITS, parseCsvArtifact, type TabularDataset } from './dataset';

const CSV = [
  'week,signups,activated,onboarding_variant',
  '2025-06-02,1240,486,legacy',
  '2025-06-09,1310,498,legacy',
  '2025-06-16,1288,404,new',
  '2025-06-23,1352,398,new',
].join('\n');

function dataset(csv = CSV): TabularDataset {
  const result = parseCsvArtifact(csv);
  if (!result.ok) throw new Error(`fixture 解析失败：${result.code}`);
  return result.dataset;
}

function analysis(overrides: Partial<AnalyticsCaseAnalysis> = {}): AnalyticsCaseAnalysis {
  return {
    overview: describeDataset(dataset()),
    metrics: [
      {
        id: 'm-activation',
        metric: '激活率',
        columns: ['signups', 'activated'],
        observation: '换到 new 引导后激活率从 38% 降到 30%',
        value: '-8pp',
      },
    ],
    hypotheses: [
      {
        id: 'h-onboarding',
        statement: '新引导流程本身导致激活率下降，而非渠道质量变化',
        supportedBy: ['m-activation'],
        validation: '按 onboarding_variant 分组回溯同渠道的激活率，再做一次小流量回滚对比',
      },
    ],
    recommendations: [
      {
        id: 'r-rollback',
        action: '对 20% 流量回滚到 legacy 引导两周',
        basedOn: ['h-onboarding'],
        expectedImpact: '若激活率回到 38% 左右即可确认归因',
      },
    ],
    risks: [
      {
        id: 'k-confound',
        kind: 'causal-inference',
        description: '引导流程切换与投放结构调整发生在同一周，两者混杂',
        mitigation: '按渠道分层比较，避免用总体激活率下结论',
      },
    ],
    ...overrides,
  };
}

const DATA_QUALITY_RISK: CaseRisk = {
  id: 'k-data',
  kind: 'data-quality',
  description: '只读到部分数据，结论的适用范围有限',
  mitigation: '在完整数据上复算关键指标后再推进',
};

describe('数据概览', () => {
  it('概览直接来自 artifact，不经过模型', () => {
    const overview = describeDataset(dataset());
    expect(overview.rowCount).toBe(4);
    expect(overview.totalRows).toBe(4);
    expect(overview.truncated).toBe(false);
    expect(overview.columns).toEqual([
      { name: 'week', type: 'date', missingRate: 0 },
      { name: 'signups', type: 'number', missingRate: 0 },
      { name: 'activated', type: 'number', missingRate: 0 },
      { name: 'onboarding_variant', type: 'text', missingRate: 0 },
    ]);
  });

  it('缺失率按实际读入的行数算', () => {
    const overview = describeDataset(dataset('a,b\n1,\n2,\n3,x\n4,y'));
    expect(overview.columns[1].missingRate).toBe(0.5);
  });

  it('空表不会算出 NaN 缺失率', () => {
    const overview = describeDataset(dataset('a,b'));
    expect(overview.rowCount).toBe(0);
    expect(overview.columns.every((column) => column.missingRate === 0)).toBe(true);
  });

  it('把截断与高缺失率列成明确的局限', () => {
    const overflow = TABULAR_DATASET_LIMITS.maxRows + 10;
    const rows = Array.from({ length: overflow }, (_, index) =>
      index % 2 === 0 ? `${index},` : `${index},ok`,
    );
    const overview = describeDataset(dataset(['value,note', ...rows].join('\n')));
    const limitations = datasetLimitations(overview);

    expect(limitations.some((item) => item.includes('文件共'))).toBe(true);
    expect(limitations.some((item) => item.includes('note'))).toBe(true);
  });

  it('缺失率不超过阈值时不算局限', () => {
    const overview = describeDataset(dataset('a,b\n1,x\n2,x\n3,x\n4,x\n5,\n6,x\n7,x\n8,x\n9,x\n10,x'));
    expect(overview.columns[1].missingRate).toBeLessThanOrEqual(HIGH_MISSING_RATE);
    expect(datasetLimitations(overview)).toEqual([]);
  });
});

describe('作答落在真实数据上', () => {
  it('五部分齐备且引用自洽时通过', () => {
    expect(validateAnalyticsCaseAnalysis(analysis(), dataset())).toEqual([]);
  });

  it('引用了数据里没有的列时拦下', () => {
    // 造一列不存在的数据是这类作答最常见也最致命的失败
    const issues = validateAnalyticsCaseAnalysis(
      analysis({
        metrics: [
          {
            id: 'm-churn',
            metric: '流失率',
            columns: ['churned_users'],
            observation: '流失率上升',
          },
        ],
        hypotheses: [
          {
            id: 'h-x',
            statement: '流失导致激活率被稀释',
            supportedBy: ['m-churn'],
            validation: '分群回溯',
          },
        ],
        recommendations: [
          { id: 'r-x', action: '做留存活动', basedOn: ['h-x'], expectedImpact: '流失率回落' },
        ],
      }),
      dataset(),
    );

    expect(issues).toEqual([
      {
        path: 'metrics[0].columns[0]',
        code: 'unknown-column',
        message: '数据里没有列 churned_users',
      },
    ]);
  });

  it('指标不说明依据哪几列时拦下', () => {
    const issues = validateAnalyticsCaseAnalysis(
      analysis({
        metrics: [
          { id: 'm-activation', metric: '激活率', columns: [], observation: '在下降' },
        ],
      }),
      dataset(),
    );
    expect(issues).toEqual([
      { path: 'metrics[0].columns', code: 'invalid-value', message: '指标必须指明依据的列' },
    ]);
  });

  it('悬空的假设拦下', () => {
    const issues = validateAnalyticsCaseAnalysis(
      analysis({
        hypotheses: [
          {
            id: 'h-guess',
            statement: '大概是渠道变差了',
            supportedBy: ['m-not-there'],
            validation: '看看渠道数据',
          },
        ],
        recommendations: [
          {
            id: 'r-x',
            action: '换渠道',
            basedOn: ['h-guess'],
            expectedImpact: '激活率回升',
          },
        ],
      }),
      dataset(),
    );
    expect(issues).toEqual([
      {
        path: 'hypotheses[0].supportedBy[0]',
        code: 'missing-reference',
        message: '找不到指标观察 m-not-there',
      },
    ]);
  });

  it('假设不说明如何验证时拦下', () => {
    const issues = validateAnalyticsCaseAnalysis(
      analysis({
        hypotheses: [
          {
            id: 'h-onboarding',
            statement: '新引导导致下降',
            supportedBy: ['m-activation'],
            validation: '  ',
          },
        ],
      }),
      dataset(),
    );
    expect(issues).toEqual([
      { path: 'hypotheses[0].validation', code: 'invalid-value', message: '假设必须说明如何验证' },
    ]);
  });

  it('跳过推理直接给建议时拦下', () => {
    const issues = validateAnalyticsCaseAnalysis(
      analysis({
        recommendations: [
          { id: 'r-blind', action: '加大投放', basedOn: [], expectedImpact: '注册量上升' },
        ],
      }),
      dataset(),
    );
    expect(issues).toEqual([
      {
        path: 'recommendations[0].basedOn',
        code: 'invalid-value',
        message: '建议必须挂在至少一条假设上',
      },
    ]);
  });

  it('五部分缺任意一部分都算不完整', () => {
    const issues = validateAnalyticsCaseAnalysis(analysis({ risks: [] }), dataset());
    expect(issues).toEqual([
      { path: 'risks', code: 'empty-section', message: 'risks 不能为空' },
    ]);
  });

  it('id 重复时拦下，避免引用指向两处', () => {
    const issues = validateAnalyticsCaseAnalysis(
      analysis({
        metrics: [
          {
            id: 'm-activation',
            metric: '激活率',
            columns: ['activated'],
            observation: '下降',
          },
          {
            id: 'm-activation',
            metric: '注册量',
            columns: ['signups'],
            observation: '平稳',
          },
        ],
      }),
      dataset(),
    );
    expect(issues).toEqual([
      { path: 'metrics[1].id', code: 'duplicate-id', message: 'id m-activation 重复' },
    ]);
  });

  it('未知风险类型拦下', () => {
    const issues = validateAnalyticsCaseAnalysis(
      analysis({
        risks: [
          {
            id: 'k-x',
            kind: 'vibes' as CaseRisk['kind'],
            description: '感觉不太对',
            mitigation: '再看看',
          },
        ],
      }),
      dataset(),
    );
    expect(issues.map((issue) => issue.code)).toContain('invalid-value');
  });
});

describe('数据局限必须被承认', () => {
  const truncatedCsv = [
    'value',
    ...Array.from({ length: TABULAR_DATASET_LIMITS.maxRows + 5 }, (_, index) => String(index)),
  ].join('\n');

  function truncatedAnalysis(risks: CaseRisk[]): AnalyticsCaseAnalysis {
    const source = dataset(truncatedCsv);
    return {
      ...analysis({ risks }),
      overview: describeDataset(source),
      metrics: [
        { id: 'm-value', metric: '取值分布', columns: ['value'], observation: '均匀递增' },
      ],
      hypotheses: [
        {
          id: 'h-value',
          statement: '数据是构造的序列',
          supportedBy: ['m-value'],
          validation: '看相邻差值是否恒定',
        },
      ],
      recommendations: [
        {
          id: 'r-value',
          action: '换真实数据再分析',
          basedOn: ['h-value'],
          expectedImpact: '结论可用于决策',
        },
      ],
    };
  }

  it('数据被截断却一条风险都不提时拦下', () => {
    // 拿一份自己都知道不完整的数据下建议，是这类题最该扣分的地方
    const target = truncatedAnalysis([
      {
        id: 'k-exec',
        kind: 'execution',
        description: '换数据需要数据团队排期',
        mitigation: '先用现有数据出方向',
      },
    ]);
    const issues = validateAnalyticsCaseAnalysis(target, dataset(truncatedCsv));

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: 'risks', code: 'unacknowledged-limitation' });
    expect(issues[0].message).toContain('文件共');
  });

  it('承认了数据质量局限就通过', () => {
    const target = truncatedAnalysis([DATA_QUALITY_RISK]);
    expect(validateAnalyticsCaseAnalysis(target, dataset(truncatedCsv))).toEqual([]);
  });

  it('数据本身没有局限时不强求 data-quality 风险', () => {
    expect(validateAnalyticsCaseAnalysis(analysis(), dataset())).toEqual([]);
  });
});
