/**
 * listConfirmed 与 T06 组合器的对接。
 *
 * 组合器在 PERSONAL_FACT_SLOTS 上是 fail closed 的：没有已确认证据就不组合。
 * 这组用例把两端接起来验一遍——未确认的 proposal 走到组合器面前时，组合必须
 * 失败，而不是「先生成、指望下游把编出来的经历删干净」。删不掉的那部分正是
 * 用户会背去考场的假经历。
 */
import { describe, expect, it } from 'vitest';
import { SOFTWARE_ENGINEERING_FORMAT_IDS } from '../plugins/legacyRoleData';
import { softwareEngineeringRolePack } from '@plugins/softwareEngineering';
import { PromptCompositionError, composePrompt } from '../prompts/composer';
import type { PromptRuntimeSnapshot } from '../prompts/composer';
import type { CandidateEvidence } from '../entities';
import { isConfirmed, toPromptEvidence, toPromptEvidenceList } from './promptEvidence';

const RUNTIME: PromptRuntimeSnapshot = {
  coreVersion: '1.0.0',
  rolePack: { id: 'software-engineering', version: '1.0.0' },
  capabilities: [],
  configSnapshotHash: 'snapshot-hash',
};

function evidence(overrides: Partial<CandidateEvidence> = {}): CandidateEvidence {
  return {
    id: 'ev-gateway',
    campaignId: 'campaign-acme',
    kind: 'experience',
    title: '示例网络 · 后端工程师',
    statement: '在示例网络担任后端工程师',
    source: {
      kind: 'resume',
      documentId: 'resume-zhang',
      start: 10,
      end: 20,
      quote: '示例网络 | 后端工程师',
    },
    occurredAt: '2021-04',
    confidence: 0.9,
    status: 'proposed',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function coachWith(items: CandidateEvidence[]): void {
  composePrompt({
    runtime: RUNTIME,
    rolePack: softwareEngineeringRolePack,
    slot: 'answerCoaching',
    formatId: SOFTWARE_ENGINEERING_FORMAT_IDS.knowledge,
    evidence: toPromptEvidenceList(items),
  });
}

describe('CandidateEvidence → PromptEvidence', () => {
  it('只有 confirmed 算已确认', () => {
    expect(isConfirmed(evidence({ status: 'confirmed' }))).toBe(true);
    expect(isConfirmed(evidence({ status: 'proposed' }))).toBe(false);
    expect(isConfirmed(evidence({ status: 'rejected' }))).toBe(false);
  });

  it('投影出组合器需要的四个字段，id 保持一致以便回指证据', () => {
    const projected = toPromptEvidence(evidence({ status: 'confirmed' }));

    expect(projected).toEqual({
      id: 'ev-gateway',
      kind: 'experience',
      statement: '在示例网络担任后端工程师',
      userConfirmed: true,
    });
  });

  it('未确认与已拒绝的条目在列表投影里就被滤掉', () => {
    const list = toPromptEvidenceList([
      evidence({ id: 'ev-1', status: 'proposed' }),
      evidence({ id: 'ev-2', status: 'rejected' }),
      evidence({ id: 'ev-3', status: 'confirmed' }),
    ]);

    expect(list.map((item) => item.id)).toEqual(['ev-3']);
  });
});

describe('未确认 proposal 不进入个人化回答', () => {
  it('只有待确认证据时，话术辅导的 Prompt 组合直接失败', () => {
    try {
      coachWith([evidence({ status: 'proposed' })]);
    } catch (error) {
      expect(error).toBeInstanceOf(PromptCompositionError);
      expect((error as PromptCompositionError).code).toBe('missing-evidence');
      return;
    }
    throw new Error('期望组合失败，但它成功了');
  });

  it('拒绝掉的证据同样不能让组合通过', () => {
    try {
      coachWith([evidence({ status: 'rejected' })]);
    } catch (error) {
      expect((error as PromptCompositionError).code).toBe('missing-evidence');
      return;
    }
    throw new Error('期望组合失败，但它成功了');
  });

  it('确认之后同一条证据带着 id 出现在 provenance 与证据小节里', () => {
    const composed = composePrompt({
      runtime: RUNTIME,
      rolePack: softwareEngineeringRolePack,
      slot: 'answerCoaching',
      formatId: SOFTWARE_ENGINEERING_FORMAT_IDS.knowledge,
      evidence: toPromptEvidenceList([evidence({ status: 'confirmed' })]),
    });

    expect(composed.provenance.evidenceIds).toEqual(['ev-gateway']);
    expect(composed.systemPrompt).toContain('[evidence:ev-gateway]');
    expect(composed.systemPrompt).toContain('在示例网络担任后端工程师');
  });
});
