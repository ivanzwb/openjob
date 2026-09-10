/**
 * 抽取端的三条边界。
 *
 * 1. 三类来源分得开：简历、优化版、自述复盘各自带 sourceKind，JD 与公司情报
 *    走另一个参数，抽取结果里不会出现它们；
 * 2. JD 只能影响顺序。它能让「Redis 这一项」排到前面，但不能让 Kubernetes
 *    变成候选人的经历；
 * 3. 每条结果都能按 [start, end) 从来源文档里逐字切回原文。
 */
import { describe, expect, it } from 'vitest';
import {
  JD_ONLY_PHRASES,
  RESUME_ID,
  RESUME_MD,
  SELF_REPORT_ID,
  candidateDocuments,
  jobContextDocuments,
} from './__fixtures__/candidateDocuments';
import { extractEvidenceProposals } from './extract';
import type { EvidenceProposal } from './types';

const CAMPAIGN_ID = 'campaign-acme';

function extract(withJobContext: boolean): EvidenceProposal[] {
  return extractEvidenceProposals({
    campaignId: CAMPAIGN_ID,
    documents: candidateDocuments(),
    ...(withJobContext ? { jobContext: jobContextDocuments() } : {}),
  });
}

function documentText(proposal: EvidenceProposal): string {
  const document = candidateDocuments().find(
    (item) => item.id === proposal.source.documentId && item.kind === proposal.source.kind,
  );
  if (!document) throw new Error(`来源文档不在候选人文档集合里：${proposal.source.documentId}`);
  return document.text;
}

describe('候选人证据抽取', () => {
  it('每条证据都能按区间从来源文档切回原文', () => {
    const proposals = extract(true);

    expect(proposals.length).toBeGreaterThan(0);
    for (const proposal of proposals) {
      const text = documentText(proposal);
      expect(
        text.slice(proposal.source.start, proposal.source.end),
        `${proposal.kind} / ${proposal.title}`,
      ).toBe(proposal.source.quote);
    }
  });

  it('简历与自述复盘分别带自己的 sourceKind，不混成一个来源字段', () => {
    const proposals = extract(true);
    const bySource = new Map<string, Set<string>>();
    for (const proposal of proposals) {
      const ids = bySource.get(proposal.source.kind) ?? new Set<string>();
      ids.add(proposal.source.documentId);
      bySource.set(proposal.source.kind, ids);
    }

    expect([...bySource.keys()].sort()).toEqual(['resume', 'selfReport']);
    expect([...(bySource.get('resume') ?? [])]).toEqual([RESUME_ID]);
    expect([...(bySource.get('selfReport') ?? [])]).toEqual([SELF_REPORT_ID]);
  });

  it('JD 与公司情报的内容一个字都不会进证据', () => {
    const proposals = extract(true);
    const leaked = proposals.filter((proposal) =>
      JD_ONLY_PHRASES.some(
        (phrase) =>
          proposal.statement.includes(phrase) ||
          proposal.source.quote.includes(phrase) ||
          proposal.title.includes(phrase),
      ),
    );

    expect(leaked).toEqual([]);
  });

  it('JD 只改排序，不改抽出来的内容', () => {
    const withJd = extract(true);
    const withoutJd = extract(false);

    const key = (proposal: EvidenceProposal): string =>
      `${proposal.kind}|${proposal.source.kind}|${proposal.source.start}|${proposal.source.quote}`;
    expect([...withJd.map(key)].sort()).toEqual([...withoutJd.map(key)].sort());
    // JD 点名了 Redis，它就该排在确认列表最前面
    expect(withJd[0].source.quote).toBe('Redis');
    expect(withoutJd[0].source.quote).not.toBe('Redis');
  });

  it('同一份输入永远抽出同一个结果，重跑不会打乱用户的确认列表', () => {
    expect(extract(true)).toEqual(extract(true));
  });

  it('技能逐项定位，而不是整行一条', () => {
    const skills = extract(true).filter((proposal) => proposal.kind === 'skill');

    expect(skills.map((proposal) => proposal.source.quote).sort()).toEqual([
      'Docker',
      'Go',
      'Java',
      'MySQL',
      'Redis',
    ]);
    const redis = skills.find((proposal) => proposal.source.quote === 'Redis');
    expect(RESUME_MD.slice(redis?.source.start, redis?.source.end)).toBe('Redis');
  });

  it('经历表头给出经历证据与起始时间，量化职责另算成果', () => {
    const proposals = extract(true);
    const experience = proposals.filter((proposal) => proposal.kind === 'experience');
    const achievements = proposals.filter((proposal) => proposal.kind === 'achievement');

    expect(experience.map((proposal) => proposal.statement)).toEqual([
      '在示例网络担任后端工程师',
      '在订单对账平台担任技术负责人',
    ]);
    expect(experience.map((proposal) => proposal.occurredAt)).toEqual(['2021-04', '2022-06']);
    expect(achievements.map((proposal) => proposal.statement)).toEqual([
      '负责网关限流与熔断，QPS 从 8000 提升到 20000',
      '对账差错率从 0.3% 降到 0.01%',
    ]);
    // 没有数字的职责行不算成果，否则确认列表会被「负责若干模块」填满
    expect(proposals.some((proposal) => proposal.statement === '参与订单服务拆分')).toBe(false);
  });

  it('证书与学历都归到 credential', () => {
    const credentials = extract(true).filter((proposal) => proposal.kind === 'credential');

    expect(credentials.map((proposal) => proposal.source.quote)).toEqual([
      'AWS 解决方案架构师',
      '示例大学 | 计算机科学与技术 · 本科 | 2014-09 ~ 2018-06',
    ]);
  });

  it('自述复盘产出 behavior，置信度低于简历结构化条目', () => {
    const behaviors = extract(true).filter((proposal) => proposal.kind === 'behavior');

    expect(behaviors).toHaveLength(2);
    for (const behavior of behaviors) {
      expect(behavior.source.kind).toBe('selfReport');
      expect(behavior.confidence).toBeLessThan(0.9);
    }
  });

  it('抽取只产出 proposal，任何一条都还没被确认', () => {
    // EvidenceProposal 上根本没有确认状态：落库后一律是 proposed，
    // 抽取端没有任何路径能直接产出一条可用证据
    for (const proposal of extract(true)) {
      expect('status' in proposal).toBe(false);
    }
  });
});
