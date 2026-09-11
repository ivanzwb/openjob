/**
 * evidenceRisk 与 stageWeight 的用例。
 *
 * 两个值都会乘进优先级，所以边界必须钉死：上界什么时候取到、下界什么时候取到、
 * 没有信息时是不是老老实实退回中性值。不钉边界的话，一个越界的乘数会安静地把
 * 某项能力顶到清单第一，而 reason 里看不出任何异常。
 */
import { describe, expect, it } from 'vitest';
import type { InterviewStageTemplate } from '../plugins/types';
import {
  MAX_STAGE_WEIGHT,
  MIN_STAGE_WEIGHT,
  NEUTRAL_STAGE_WEIGHT,
  computeEvidenceRisk,
  computeStageWeight,
  type CompetencyEvidenceSignal,
} from './factors';

function signal(
  kind: CompetencyEvidenceSignal['kind'],
  confidence = 1,
  relevance = 1,
): CompetencyEvidenceSignal {
  return { kind, confidence, relevance };
}

describe('computeEvidenceRisk', () => {
  it('没有证据时不产生风险——那是短板，不是「说了没证据」', () => {
    const result = computeEvidenceRisk([]);
    expect(result.claimStrength).toBe(0);
    expect(result.evidenceStrength).toBe(0);
    expect(result.evidenceRisk).toBe(1);
  });

  it('带结果的成就能完全撑住声称，风险回到中性', () => {
    const result = computeEvidenceRisk([signal('achievement')]);
    expect(result.evidenceStrength).toBeCloseTo(1, 10);
    expect(result.evidenceRisk).toBeCloseTo(1, 10);
  });

  it('只有「我会 X」这类技能声称时取上界', () => {
    const result = computeEvidenceRisk([signal('skill')]);
    expect(result.claimStrength).toBeCloseTo(1, 10);
    expect(result.evidenceStrength).toBe(0);
    expect(result.evidenceRisk).toBeCloseTo(2, 10);
  });

  it('技能声称越堆越多也换不出证据，风险仍在上界', () => {
    const many = Array.from({ length: 10 }, () => signal('skill', 0.9));
    const result = computeEvidenceRisk(many);
    expect(result.evidenceStrength).toBe(0);
    expect(result.evidenceRisk).toBeCloseTo(2, 6);
  });

  it('亲历经历按 0.8 折算，剩下的落差就是风险', () => {
    const result = computeEvidenceRisk([signal('experience', 0.8)]);
    expect(result.claimStrength).toBeCloseTo(0.8, 10);
    expect(result.evidenceStrength).toBeCloseTo(0.64, 10);
    expect(result.evidenceRisk).toBeCloseTo(1.16, 10);
  });

  it('相关度低的证据同时削弱声称和佐证，不会凭空放大风险', () => {
    const weak = computeEvidenceRisk([signal('skill', 1, 0.5)]);
    expect(weak.claimStrength).toBeCloseTo(0.5, 10);
    expect(weak.evidenceRisk).toBeCloseTo(1.5, 10);
  });

  it('一条硬证据能压住同一能力上的多条空声称', () => {
    const bare = computeEvidenceRisk([signal('skill'), signal('skill')]);
    const backed = computeEvidenceRisk([signal('skill'), signal('skill'), signal('achievement')]);
    expect(backed.evidenceRisk).toBeLessThan(bare.evidenceRisk);
  });

  it('置信度非法时按 0 计，不产生 NaN 倍率', () => {
    const result = computeEvidenceRisk([signal('experience', Number.NaN)]);
    expect(Number.isFinite(result.evidenceRisk)).toBe(true);
    expect(result.evidenceRisk).toBe(1);
  });
});

const STAGES: InterviewStageTemplate[] = [
  { id: 'screen', label: '初筛', order: 0, formatIds: ['knowledge'], defaultWeight: 0.2 },
  { id: 'coding', label: '编码', order: 1, formatIds: ['coding'], defaultWeight: 0.3 },
  { id: 'design', label: '设计', order: 2, formatIds: ['design'], defaultWeight: 0.3 },
  { id: 'project', label: '项目', order: 3, formatIds: ['project'], defaultWeight: 0.2 },
];

describe('computeStageWeight', () => {
  it('岗位包没有轮次声明时退回中性值', () => {
    const result = computeStageWeight({ stages: [], formatIds: ['coding'] });
    expect(result.stageWeight).toBe(NEUTRAL_STAGE_WEIGHT);
    expect(result.stageIds).toEqual([]);
  });

  it('下一轮就考、且是分量最重的一轮，取上界', () => {
    const result = computeStageWeight({
      stages: STAGES,
      formatIds: ['coding'],
      upcomingStageId: 'coding',
    });
    expect(result.stageWeight).toBeCloseTo(MAX_STAGE_WEIGHT, 10);
    expect(result.stageIds).toEqual(['coding']);
  });

  it('剩余轮次都不考这项能力时压到下界，但不清零', () => {
    const result = computeStageWeight({
      stages: STAGES,
      formatIds: ['portfolio'],
      upcomingStageId: 'coding',
    });
    expect(result.stageWeight).toBeCloseTo(MIN_STAGE_WEIGHT, 10);
    expect(result.stageIds).toEqual([]);
  });

  it('已经面完的轮次不再计入，只看后面还会考的那些', () => {
    // screen 已过；project 在两轮之后：0.6² × (0.2 / 0.3)
    const result = computeStageWeight({
      stages: STAGES,
      formatIds: ['knowledge', 'project'],
      upcomingStageId: 'coding',
    });
    expect(result.stageIds).toEqual(['screen', 'project']);
    expect(result.stageWeight).toBeCloseTo(0.6 + 0.8 * 0.24, 10);
  });

  it('越靠后的轮次权重越低', () => {
    const next = computeStageWeight({
      stages: STAGES,
      formatIds: ['coding'],
      upcomingStageId: 'coding',
    });
    const later = computeStageWeight({
      stages: STAGES,
      formatIds: ['project'],
      upcomingStageId: 'coding',
    });
    expect(later.stageWeight).toBeLessThan(next.stageWeight);
  });

  it('没给下一轮或给了不存在的轮次，都从最早那一轮算起', () => {
    const unspecified = computeStageWeight({ stages: STAGES, formatIds: ['coding'] });
    const unknown = computeStageWeight({
      stages: STAGES,
      formatIds: ['coding'],
      upcomingStageId: 'no-such-stage',
    });
    expect(unknown.stageWeight).toBeCloseTo(unspecified.stageWeight, 10);
    // 从 screen 起算，coding 在下一轮：0.6 × (0.3 / 0.3)
    expect(unspecified.stageWeight).toBeCloseTo(0.6 + 0.8 * 0.6, 10);
  });

  it('轮次权重全为 0 的畸形岗位包退回中性值', () => {
    const broken = STAGES.map((stage) => ({ ...stage, defaultWeight: 0 }));
    const result = computeStageWeight({ stages: broken, formatIds: ['coding'] });
    expect(result.stageWeight).toBe(NEUTRAL_STAGE_WEIGHT);
  });
});
