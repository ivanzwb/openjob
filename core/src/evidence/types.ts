/**
 * CandidateEvidence 服务的契约。
 *
 * 这一层要守住的边界只有一条，但它是整个个人化回答链条的地基：候选人事实和
 * 岗位要求长得很像，都是「和这个岗位有关的一段文字」，可一旦 JD 里的职责描述
 * 流进候选人证据，用户就会背着一段没发生过的经历进考场——比答不上来严重得多。
 *
 * 所以来源在类型上就分成两组不相交的文档：
 *
 * - CandidateDocument（简历 / 优化版 / 自己的面后复盘）能产出证据；
 * - JobContextDocument（JD / 公司情报）只能影响先抽哪一条，永远不进 statement。
 *
 * 类型分开挡得住写错代码，挡不住经 IPC 反序列化进来的任意 JSON，所以
 * grounding.ts 还会在落库前把每条 proposal 的引文放回原文里重新定位一次。
 */

import type {
  CandidateEvidenceKind,
  CandidateSourceKind,
  JobContextSourceKind,
} from '../enums';
import type { CandidateEvidence, EvidenceSourceRef, Id } from '../entities';

/** 候选人自述文档：唯一允许产出 CandidateEvidence 的输入 */
export interface CandidateDocument {
  kind: CandidateSourceKind;
  id: Id;
  /** 原文全文。证据的字符区间就是相对这份文本的偏移 */
  text: string;
}

/**
 * 岗位侧文档。
 *
 * 与 CandidateDocument 字段几乎一样，却刻意不共用一个类型：两者一旦能互相赋值，
 * 「JD 不能变成证据」就只剩注释在保证了。
 */
export interface JobContextDocument {
  kind: JobContextSourceKind;
  id: Id;
  text: string;
}

/** 待用户确认的证据候选。与 CandidateEvidence 的区别只有「还没被确认」 */
export interface EvidenceProposal {
  campaignId: Id;
  kind: CandidateEvidenceKind;
  title: string;
  statement: string;
  source: EvidenceSourceRef;
  occurredAt: string | null;
  confidence: number;
}

export interface EvidenceExtractionInput {
  campaignId: Id;
  /** 候选人自述文档 */
  documents: readonly CandidateDocument[];
  /** 岗位上下文，只用于排序，可不传 */
  jobContext?: readonly JobContextDocument[];
}

export interface EvidenceScope {
  campaignId: Id;
  /** 限定来源文档类型；不传表示全部候选人来源 */
  sourceKinds?: readonly CandidateSourceKind[];
  /** 限定事实类型 */
  kinds?: readonly CandidateEvidenceKind[];
}

export interface EvidenceService {
  /** 纯计算：只产出 proposal，不落库，也不改任何已确认证据 */
  extract(input: EvidenceExtractionInput): Promise<EvidenceProposal[]>;
  /** 只返回 status === 'confirmed' 的条目，直接对齐 T06 组合器的 fail-closed */
  listConfirmed(scope: EvidenceScope): Promise<CandidateEvidence[]>;
  propose(input: EvidenceProposal): Promise<CandidateEvidence>;
  confirm(id: string): Promise<CandidateEvidence>;
  reject(id: string): Promise<void>;
}
