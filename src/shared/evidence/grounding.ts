/**
 * 证据落库前的定位校验。
 *
 * 类型上把 JD 和简历分开只在编译期成立。真正写库的入参来自 IPC / RPC，
 * 那是一段任意 JSON——`source.kind` 可以是 `'jd'`，`quote` 可以是一句 JD 原文。
 * 所以每条 proposal 都必须能被放回一份候选人文档里逐字对上：
 *
 * 1. 来源类型在候选人来源集合里（jd / company 直接拒）；
 * 2. 引用的文档确实是本次 Campaign 的候选人文档；
 * 3. `document.text.slice(start, end)` 与 `quote` 完全相等。
 *
 * 第 3 条同时兑现了「每条 Evidence 可定位原文」和「JD 内容不能成为证据」：
 * 一句 JD 里的话在简历里定位不到，也就写不进来。
 */

import {
  CANDIDATE_EVIDENCE_KINDS,
  CANDIDATE_SOURCE_KINDS,
  JOB_CONTEXT_SOURCE_KINDS,
  type CandidateEvidenceKind,
  type CandidateSourceKind,
  type JobContextSourceKind,
} from '../enums';
import type { EvidenceSourceRef } from '../entities';
import type { CandidateDocument, EvidenceProposal } from './types';

export type EvidenceRejectionCode =
  /** 来源类型不是候选人自述文档（典型是 jd / company） */
  | 'job-context-source'
  | 'unknown-source-kind'
  | 'unknown-kind'
  | 'source-document-missing'
  /** 引文在来源文档的该区间上对不上，无法回指原文 */
  | 'quote-not-anchored'
  | 'empty-statement'
  | 'invalid-range'
  | 'invalid-confidence';

export class EvidenceRejectedError extends Error {
  readonly code: EvidenceRejectionCode;
  readonly detail?: string;

  constructor(code: EvidenceRejectionCode, message: string, detail?: string) {
    super(message);
    this.name = 'EvidenceRejectedError';
    this.code = code;
    this.detail = detail;
  }
}

export function isCandidateSourceKind(value: string): value is CandidateSourceKind {
  return (CANDIDATE_SOURCE_KINDS as readonly string[]).includes(value);
}

export function isJobContextSourceKind(value: string): value is JobContextSourceKind {
  return (JOB_CONTEXT_SOURCE_KINDS as readonly string[]).includes(value);
}

export function isCandidateEvidenceKind(value: string): value is CandidateEvidenceKind {
  return (CANDIDATE_EVIDENCE_KINDS as readonly string[]).includes(value);
}

/** 定位结果。命中时给出所在行号，UI 要能把用户带回原文那一行 */
export interface EvidenceLocation {
  documentId: string;
  sourceKind: CandidateSourceKind;
  start: number;
  end: number;
  quote: string;
  /** 1 起算 */
  line: number;
}

export function locateInDocument(
  source: EvidenceSourceRef,
  document: CandidateDocument,
): EvidenceLocation | null {
  if (document.id !== source.documentId || document.kind !== source.kind) return null;
  if (document.text.slice(source.start, source.end) !== source.quote) return null;
  return {
    documentId: document.id,
    sourceKind: document.kind,
    start: source.start,
    end: source.end,
    quote: source.quote,
    line: document.text.slice(0, source.start).split('\n').length,
  };
}

/**
 * 校验并返回定位结果。
 *
 * 抛错而不是返回 null：调用点拿不到定位时唯一正确的处理是拒绝这条证据，
 * 把「定位失败」做成一个能继续往下走的返回值，迟早会有人忽略它。
 */
export function assertProposalGrounded(
  proposal: EvidenceProposal,
  documents: readonly CandidateDocument[],
): EvidenceLocation {
  const { source } = proposal;
  const sourceKind = source.kind as string;

  if (isJobContextSourceKind(sourceKind)) {
    throw new EvidenceRejectedError(
      'job-context-source',
      `${sourceKind} 描述的是岗位要求，不能作为候选人证据的来源`,
      sourceKind,
    );
  }
  if (!isCandidateSourceKind(sourceKind)) {
    throw new EvidenceRejectedError('unknown-source-kind', `未知的证据来源类型：${sourceKind}`);
  }
  if (!isCandidateEvidenceKind(proposal.kind as string)) {
    throw new EvidenceRejectedError('unknown-kind', `未知的证据分类：${String(proposal.kind)}`);
  }
  if (proposal.statement.trim().length === 0) {
    throw new EvidenceRejectedError('empty-statement', '证据陈述为空');
  }
  if (
    !Number.isInteger(source.start) ||
    !Number.isInteger(source.end) ||
    source.start < 0 ||
    source.end <= source.start
  ) {
    throw new EvidenceRejectedError(
      'invalid-range',
      `原文区间不合法：[${source.start}, ${source.end})`,
    );
  }
  if (!(proposal.confidence >= 0 && proposal.confidence <= 1)) {
    throw new EvidenceRejectedError(
      'invalid-confidence',
      `置信度必须在 0-1：${proposal.confidence}`,
    );
  }

  const document = documents.find(
    (item) => item.id === source.documentId && item.kind === source.kind,
  );
  if (!document) {
    throw new EvidenceRejectedError(
      'source-document-missing',
      `找不到来源文档 ${sourceKind}:${source.documentId}`,
    );
  }

  const location = locateInDocument(source, document);
  if (!location) {
    throw new EvidenceRejectedError(
      'quote-not-anchored',
      `引文无法在 ${sourceKind}:${source.documentId} 的 [${source.start}, ${source.end}) 上定位`,
      source.quote,
    );
  }
  return location;
}
