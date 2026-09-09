/**
 * 证据复核界面的分组与出处描述。
 *
 * T10 保证每条 CandidateEvidence 都能定位回原文，界面这一侧的责任就是把那份定位真的
 * 显示出来。只给一句提炼后的陈述让用户点「确认」，等于让他凭印象判断这句话是不是自己
 * 写过的——而确认过的证据会直接进个人化回答，认错一条的代价是带着一段没发生过的经历
 * 进考场。所以每一条都带上来源文档、字符区间和逐字引文。
 *
 * 区间自校验也放在这里：quote 的长度必须等于 end - start。这是 T10 落库时的不变量，
 * 对不上说明这条记录已经和原文脱钩，界面要把它标出来而不是照常渲染一段引文。
 */

import { CANDIDATE_SOURCE_KINDS, type CandidateEvidenceKind, type CandidateSourceKind } from '../enums';
import type { CandidateEvidence, EvidenceSourceRef } from '../entities';

export const CANDIDATE_SOURCE_LABELS: Record<CandidateSourceKind, string> = {
  resume: '简历母版',
  resumeVariant: '定制简历',
  selfReport: '面后复盘',
};

export const CANDIDATE_EVIDENCE_KIND_LABELS: Record<CandidateEvidenceKind, string> = {
  experience: '经历',
  achievement: '成果',
  skill: '技能',
  behavior: '行为',
  credential: '资历',
};

/** 渲染进程能拿到的文档标题；取不到时退回来源类型，不猜文档名 */
export interface EvidenceDocumentLabel {
  id: string;
  label: string;
}

export interface EvidenceOrigin {
  sourceLabel: string;
  documentLabel: string;
  /** 「第 120–158 字」 */
  rangeLabel: string;
  quote: string;
  /** 引文与区间对不上：这条证据已经无法定位回原文 */
  broken: boolean;
}

export function describeEvidenceOrigin(
  source: EvidenceSourceRef,
  documents: readonly EvidenceDocumentLabel[] = [],
): EvidenceOrigin {
  const sourceLabel = CANDIDATE_SOURCE_LABELS[source.kind];
  const document = documents.find((item) => item.id === source.documentId);
  const broken = source.end <= source.start || source.end - source.start !== source.quote.length;
  return {
    sourceLabel,
    documentLabel: document?.label ?? sourceLabel,
    // 区间是半开的 [start, end)，显示成从 1 开始的闭区间更接近「第几个字」的直觉
    rangeLabel: `第 ${source.start + 1}–${source.end} 字`,
    quote: source.quote,
    broken,
  };
}

export interface EvidenceGroup {
  kind: CandidateSourceKind;
  label: string;
  items: CandidateEvidence[];
}

/**
 * 按来源文档分组。
 *
 * 分组本身就是一次复核提示：同一段简历里抽出来的十条证据放在一起，用户一眼能看出哪几条
 * 其实是同一件事被拆开了；混在一个长列表里就只能一条条读。
 */
export function groupEvidenceBySource(items: readonly CandidateEvidence[]): EvidenceGroup[] {
  return CANDIDATE_SOURCE_KINDS.map((kind) => ({
    kind,
    label: CANDIDATE_SOURCE_LABELS[kind],
    items: sortEvidenceForReview(items.filter((item) => item.source.kind === kind)),
  })).filter((group) => group.items.length > 0);
}

/** 置信度高的排前面；同分按标题稳定排序，避免每次重拉顺序都变 */
export function sortEvidenceForReview(items: readonly CandidateEvidence[]): CandidateEvidence[] {
  return [...items].sort(
    (left, right) =>
      right.confidence - left.confidence ||
      (left.title < right.title ? -1 : left.title > right.title ? 1 : 0),
  );
}

export interface EvidenceReviewSummary {
  proposedCount: number;
  confirmedCount: number;
  /** 引文对不上原文的条数；大于 0 时界面要提示重新抽取 */
  brokenCount: number;
  message: string;
}

export function summarizeEvidenceReview(input: {
  proposed: readonly CandidateEvidence[];
  confirmed: readonly CandidateEvidence[];
}): EvidenceReviewSummary {
  const brokenCount = [...input.proposed, ...input.confirmed].filter(
    (item) => describeEvidenceOrigin(item.source).broken,
  ).length;

  const parts: string[] = [];
  if (input.proposed.length > 0) parts.push(`${input.proposed.length} 条待确认`);
  if (input.confirmed.length > 0) parts.push(`${input.confirmed.length} 条已确认`);
  if (brokenCount > 0) parts.push(`${brokenCount} 条定位失效`);

  return {
    proposedCount: input.proposed.length,
    confirmedCount: input.confirmed.length,
    brokenCount,
    message: parts.length > 0 ? parts.join(' · ') : '还没有抽取过候选人证据',
  };
}
