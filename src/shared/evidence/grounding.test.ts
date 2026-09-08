/**
 * 定位校验是「JD 不能成为候选人证据」的运行时防线。
 *
 * 类型上 JobContextDocument 与 CandidateDocument 不通用，但落库入参来自 IPC，
 * 那就是一段任意 JSON——一个手写的 `{ kind: 'jd' }` 或一句 JD 原文完全能走到
 * 这里。所以这组用例全部用「绕过类型之后」的入参：`as unknown as` 不是偷懒，
 * 它演的就是真实调用方。
 */
import { describe, expect, it } from 'vitest';
import {
  JD_RAW,
  RESUME_ID,
  RESUME_MD,
  candidateDocuments,
} from './__fixtures__/candidateDocuments';
import {
  EvidenceRejectedError,
  assertProposalGrounded,
  isCandidateSourceKind,
  isJobContextSourceKind,
  locateInDocument,
  type EvidenceRejectionCode,
} from './grounding';
import type { EvidenceProposal } from './types';

const QUOTE = 'AWS 解决方案架构师';
const QUOTE_START = RESUME_MD.indexOf(QUOTE);

function proposal(overrides: Partial<EvidenceProposal> = {}): EvidenceProposal {
  return {
    campaignId: 'campaign-acme',
    kind: 'credential',
    title: QUOTE,
    statement: QUOTE,
    source: {
      kind: 'resume',
      documentId: RESUME_ID,
      start: QUOTE_START,
      end: QUOTE_START + QUOTE.length,
      quote: QUOTE,
    },
    occurredAt: null,
    confidence: 0.8,
    ...overrides,
  };
}

function rejection(input: EvidenceProposal): EvidenceRejectionCode {
  try {
    assertProposalGrounded(input, candidateDocuments());
  } catch (error) {
    if (error instanceof EvidenceRejectedError) return error.code;
    throw error;
  }
  throw new Error('期望这条证据被拒，但它通过了');
}

describe('来源类型的两个集合互不相交', () => {
  it('jd / company 不是候选人来源，resume 系不是岗位来源', () => {
    expect(isJobContextSourceKind('jd')).toBe(true);
    expect(isJobContextSourceKind('company')).toBe(true);
    expect(isCandidateSourceKind('jd')).toBe(false);
    expect(isCandidateSourceKind('company')).toBe(false);

    for (const kind of ['resume', 'resumeVariant', 'selfReport']) {
      expect(isCandidateSourceKind(kind), kind).toBe(true);
      expect(isJobContextSourceKind(kind), kind).toBe(false);
    }
  });
});

describe('JD 内容不能成为 CandidateEvidence', () => {
  it('来源类型写成 jd 时直接拒，并指出原因是岗位侧来源', () => {
    const forged = proposal({
      source: {
        ...proposal().source,
        kind: 'jd' as unknown as 'resume',
      },
    });

    expect(rejection(forged)).toBe('job-context-source');
  });

  it('来源类型写成 company 时同样被拒', () => {
    const forged = proposal({
      source: { ...proposal().source, kind: 'company' as unknown as 'resume' },
    });

    expect(rejection(forged)).toBe('job-context-source');
  });

  it('借简历的 documentId 塞一句 JD 原文，定位对不上而被拒', () => {
    // 最像真事故的形态：来源类型是合法的 resume，statement 却是 JD 里那句
    // 「主导过跨机房容灾演练」。用户看到的会是一条自己从没做过的经历。
    const jdSentence = '主导过 跨机房容灾演练';
    expect(JD_RAW).toContain(jdSentence);
    const forged = proposal({
      statement: jdSentence,
      source: {
        kind: 'resume',
        documentId: RESUME_ID,
        start: QUOTE_START,
        end: QUOTE_START + jdSentence.length,
        quote: jdSentence,
      },
    });

    expect(rejection(forged)).toBe('quote-not-anchored');
  });

  it('把 JD 当成一份候选人文档传进来也不行——文档集合里没有它', () => {
    const forged = proposal({
      source: { ...proposal().source, documentId: 'campaign-acme' },
    });

    expect(rejection(forged)).toBe('source-document-missing');
  });
});

describe('每条证据可定位原文', () => {
  it('区间对得上时返回原文位置与行号', () => {
    const location = assertProposalGrounded(proposal(), candidateDocuments());

    expect(location.quote).toBe(QUOTE);
    expect(RESUME_MD.slice(location.start, location.end)).toBe(QUOTE);
    expect(RESUME_MD.split('\n')[location.line - 1]).toContain(QUOTE);
  });

  it('原文被改动、区间漂到别的文字上时拒绝', () => {
    const drifted = proposal({
      source: { ...proposal().source, start: QUOTE_START + 2 },
    });

    expect(rejection(drifted)).toBe('quote-not-anchored');
  });

  it('区间不合法、陈述为空、置信度越界都拒绝', () => {
    expect(rejection(proposal({ source: { ...proposal().source, end: QUOTE_START } }))).toBe(
      'invalid-range',
    );
    expect(rejection(proposal({ statement: '   ' }))).toBe('empty-statement');
    expect(rejection(proposal({ confidence: 1.5 }))).toBe('invalid-confidence');
  });

  it('定位要求文档 id 与 sourceKind 同时对上', () => {
    const source = proposal().source;
    const [resume] = candidateDocuments();

    expect(locateInDocument(source, resume)).not.toBeNull();
    expect(locateInDocument({ ...source, documentId: 'other' }, resume)).toBeNull();
    expect(locateInDocument({ ...source, kind: 'resumeVariant' }, resume)).toBeNull();
  });
});
