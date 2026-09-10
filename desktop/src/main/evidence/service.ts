/**
 * EvidenceService 的桌面实现。
 *
 * 两条边界在这里合流，因为它们其实是同一条：
 *
 * - 「每条 Evidence 可定位原文」要求落库前把引文放回来源文档里逐字对上；
 * - 「JD 内容不能成为 CandidateEvidence」要求来源文档只能是候选人自述文档。
 *
 * 于是 propose 只做一件事：拿本次 Campaign 的候选人文档集合去定位这条 proposal。
 * 定位不上就拒——一句 JD 原文在简历里定位不到，所以它连带着被挡在外面，
 * 而不是靠一条「记得别传 JD」的约定。
 *
 * confirm 会再定位一次。抽取和确认之间用户完全可能改过简历，改完之后那条引文
 * 指向的可能已经是另一段文字了；带着错位的区间确认下去，用户点开证据看到的就是
 * 别的经历，而这条证据接着会被当成事实注入 prompt。
 */

import type { Database } from 'better-sqlite3';
import type { CandidateEvidence } from '@core/entities';
import {
  assertProposalGrounded,
  extractEvidenceProposals,
  type EvidenceLocation,
  type EvidenceProposal,
  type EvidenceScope,
  type EvidenceService,
  type EvidenceExtractionInput,
} from '@core/evidence';
import { loadCandidateDocuments, loadJobContextDocuments } from './documents';
import {
  getEvidence,
  insertProposal,
  listConfirmedEvidence,
  setEvidenceStatus,
} from './repository';

export interface EvidenceServiceOptions {
  now?: () => number;
  newId?: () => string;
}

function ground(
  raw: Database,
  proposal: EvidenceProposal,
): EvidenceLocation {
  return assertProposalGrounded(proposal, loadCandidateDocuments(raw, proposal.campaignId));
}

/**
 * 抽取入口。
 *
 * 调用方不传 documents 时由本模块按 Campaign 取数，岗位上下文一并带上——
 * 岗位相关度影响的只有确认列表的排序，不影响能抽出什么。
 */
export function extractCampaignEvidence(
  raw: Database,
  campaignId: string,
): EvidenceProposal[] {
  return extractEvidenceProposals({
    campaignId,
    documents: loadCandidateDocuments(raw, campaignId),
    jobContext: loadJobContextDocuments(raw, campaignId),
  });
}

export function createEvidenceService(
  raw: Database,
  options: EvidenceServiceOptions = {},
): EvidenceService {
  const now = (): number => options.now?.() ?? Date.now();

  return {
    async extract(input: EvidenceExtractionInput): Promise<EvidenceProposal[]> {
      return extractEvidenceProposals(input);
    },

    async listConfirmed(scope: EvidenceScope): Promise<CandidateEvidence[]> {
      return listConfirmedEvidence(raw, scope);
    },

    async propose(input: EvidenceProposal): Promise<CandidateEvidence> {
      ground(raw, input);
      return insertProposal(raw, input, { now, newId: options.newId });
    },

    async confirm(id: string): Promise<CandidateEvidence> {
      const evidence = getEvidence(raw, id);
      if (!evidence) throw new Error(`证据不存在：${id}`);
      ground(raw, evidence);
      setEvidenceStatus(raw, id, 'confirmed', now());
      const confirmed = getEvidence(raw, id);
      if (!confirmed) throw new Error(`证据确认后不可读：${id}`);
      return confirmed;
    },

    async reject(id: string): Promise<void> {
      const evidence = getEvidence(raw, id);
      if (!evidence) throw new Error(`证据不存在：${id}`);
      // 标记而不是删除：删掉之后同一段原文下次抽取又会冒出来，用户得反复拒同一条
      setEvidenceStatus(raw, id, 'rejected', now());
    },
  };
}
