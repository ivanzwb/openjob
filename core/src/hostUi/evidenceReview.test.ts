import { describe, expect, it } from 'vitest';
import type { CandidateEvidence } from '../entities';
import type { CandidateSourceKind } from '../enums';
import {
  describeEvidenceOrigin,
  groupEvidenceBySource,
  sortEvidenceForReview,
  summarizeEvidenceReview,
} from './evidenceReview';

const RESUME_TEXT = '2021 年主导订单系统重构，把下单成功率从 98.2% 提到 99.7%。';

function evidence(overrides: Partial<CandidateEvidence> & { quote: string }): CandidateEvidence {
  const start = RESUME_TEXT.indexOf(overrides.quote);
  return {
    id: overrides.id ?? `ev-${overrides.quote.slice(0, 4)}`,
    campaignId: 'c-1',
    kind: 'experience',
    title: overrides.title ?? overrides.quote.slice(0, 6),
    statement: overrides.statement ?? overrides.quote,
    source: overrides.source ?? {
      kind: 'resume',
      documentId: 'r-1',
      start,
      end: start + overrides.quote.length,
      quote: overrides.quote,
    },
    occurredAt: null,
    confidence: overrides.confidence ?? 0.8,
    status: overrides.status ?? 'proposed',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as CandidateEvidence;
}

function withSource(kind: CandidateSourceKind, quote: string, confidence = 0.5): CandidateEvidence {
  const base = evidence({ quote, confidence });
  return { ...base, id: `${kind}-${quote}`, source: { ...base.source, kind } };
}

describe('describeEvidenceOrigin', () => {
  it('给出来源类型、文档标题、字符区间和逐字引文', () => {
    const item = evidence({ quote: '主导订单系统重构' });

    expect(describeEvidenceOrigin(item.source, [{ id: 'r-1', label: '我的简历 v3' }])).toEqual({
      sourceLabel: '简历母版',
      documentLabel: '我的简历 v3',
      rangeLabel: `第 ${item.source.start + 1}–${item.source.end} 字`,
      quote: '主导订单系统重构',
      broken: false,
    });
  });

  it('查不到文档标题时退回来源类型，不猜一个文件名出来', () => {
    const item = evidence({ quote: '订单系统' });
    expect(describeEvidenceOrigin(item.source, []).documentLabel).toBe('简历母版');
  });

  /**
   * quote 的长度必须等于 end - start，这是 T10 落库时的不变量。对不上说明这条记录已经
   * 和原文脱钩，界面要标出来，而不是照着 quote 渲染一段看着像原文的字。
   */
  it('引文长度与区间对不上时标成定位失效', () => {
    const item = evidence({ quote: '订单系统' });
    const broken = { ...item.source, end: item.source.end + 5 };

    expect(describeEvidenceOrigin(broken).broken).toBe(true);
  });

  it('空区间同样算失效', () => {
    const item = evidence({ quote: '订单系统' });
    expect(describeEvidenceOrigin({ ...item.source, end: item.source.start, quote: '' }).broken).toBe(
      true,
    );
  });
});

describe('groupEvidenceBySource', () => {
  it('按来源文档分组，顺序固定为简历母版 → 定制简历 → 面后复盘', () => {
    const groups = groupEvidenceBySource([
      withSource('selfReport', '下单成功率'),
      withSource('resume', '订单系统'),
      withSource('resumeVariant', '重构'),
    ]);

    expect(groups.map((group) => group.kind)).toEqual(['resume', 'resumeVariant', 'selfReport']);
    expect(groups.map((group) => group.label)).toEqual(['简历母版', '定制简历', '面后复盘']);
  });

  it('空分组不占版面', () => {
    const groups = groupEvidenceBySource([withSource('resume', '订单系统')]);
    expect(groups).toHaveLength(1);
  });

  it('组内按置信度从高到低排，同分按标题稳定排序', () => {
    const low = { ...withSource('resume', '重构', 0.2), title: 'b' };
    const high = { ...withSource('resume', '订单系统', 0.9), title: 'a' };
    const same = { ...withSource('resume', '下单成功率', 0.2), title: 'a' };

    expect(groupEvidenceBySource([low, high, same]).at(0)!.items.map((item) => item.title)).toEqual([
      'a',
      'a',
      'b',
    ]);
    expect(sortEvidenceForReview([low, high]).at(0)!.title).toBe('a');
  });
});

describe('summarizeEvidenceReview', () => {
  it('没有任何证据时说清楚是「还没抽取过」，而不是显示 0 条待确认', () => {
    expect(summarizeEvidenceReview({ proposed: [], confirmed: [] })).toMatchObject({
      proposedCount: 0,
      confirmedCount: 0,
      brokenCount: 0,
      message: '还没有抽取过候选人证据',
    });
  });

  it('分别数出待确认与已确认', () => {
    const summary = summarizeEvidenceReview({
      proposed: [withSource('resume', '订单系统')],
      confirmed: [withSource('selfReport', '重构'), withSource('resumeVariant', '下单成功率')],
    });

    expect(summary.message).toBe('1 条待确认 · 2 条已确认');
  });

  it('定位失效的条数单独报出来，提示用户重新抽取', () => {
    const item = withSource('resume', '订单系统');
    const summary = summarizeEvidenceReview({
      proposed: [{ ...item, source: { ...item.source, end: item.source.end + 3 } }],
      confirmed: [],
    });

    expect(summary.brokenCount).toBe(1);
    expect(summary.message).toContain('1 条定位失效');
  });
});
