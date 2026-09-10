/**
 * CandidateEvidence → T06 组合器的 PromptEvidence。
 *
 * 组合器自己也会把 `userConfirmed !== true` 的条目滤掉，这里再挡一次不是重复
 * 保险：两处挡的是不同的错。组合器挡的是「调用方传了未确认的条目」，这里挡的是
 * 「未确认的条目根本不该从数据层流出来」。少了后者，某天一个新调用点直接把
 * listAll 的结果塞进 prompt，也只是运气好才没出事。
 */

import type { PromptEvidence } from '../prompts/composer';
import type { CandidateEvidence } from '../entities';

export function isConfirmed(evidence: CandidateEvidence): boolean {
  return evidence.status === 'confirmed';
}

export function toPromptEvidence(evidence: CandidateEvidence): PromptEvidence {
  return {
    id: evidence.id,
    kind: evidence.kind,
    statement: evidence.statement,
    userConfirmed: isConfirmed(evidence),
  };
}

/** 组合 prompt 时只能用这个函数取证据 */
export function toPromptEvidenceList(
  evidence: readonly CandidateEvidence[],
): PromptEvidence[] {
  return evidence.filter(isConfirmed).map(toPromptEvidence);
}
