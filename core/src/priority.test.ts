/**
 * 优先级公式的用例。
 *
 * 重点不在算术，而在「加了两个因子之后，拿不到这两个因子的老调用点必须算出和
 * 以前一模一样的分」。考点树只有 JD × 简历这一层信息，如果缺省值悄悄改了排序，
 * 用户会在没做任何操作的情况下看到当天计划整个变样。
 */
import { describe, expect, it } from 'vitest';
import { computePriority } from './priority';

const NODE = {
  id: 'n-index',
  coverageType: 'gap' as const,
  examProb: 0.8,
  mastery: 1,
  estMinutes: 20,
};

describe('computePriority', () => {
  it('不传因子时沿用原公式与原 reason', () => {
    const result = computePriority(NODE);
    // 0.8 × (3 − 1) × 1 ÷ 20
    expect(result.score).toBeCloseTo(0.08, 10);
    expect(result.reason).toBe('短板 · 考察概率 80% · 掌握差距 2.0/3 · 预估 20 分钟');
  });

  it('evidenceRisk 与 stageWeight 直接相乘', () => {
    const result = computePriority(NODE, undefined, { evidenceRisk: 1.5, stageWeight: 1.2 });
    expect(result.score).toBeCloseTo(0.08 * 1.5 * 1.2, 10);
  });

  it('因子非中性时把倍率写进 reason，用户能看出排序被什么改过', () => {
    const result = computePriority(NODE, undefined, { evidenceRisk: 1.75, stageWeight: 0.6 });
    expect(result.reason).toContain('证据风险 ×1.75');
    expect(result.reason).toContain('轮次权重 ×0.6');
  });

  it('因子为 1 时不往 reason 里加噪声', () => {
    const result = computePriority(NODE, undefined, { evidenceRisk: 1, stageWeight: 1 });
    expect(result.reason).toBe(computePriority(NODE).reason);
  });

  it('因子非法时退回 1，而不是把整条排序清零', () => {
    const broken = computePriority(NODE, undefined, {
      evidenceRisk: Number.NaN,
      stageWeight: -3,
    });
    expect(broken.score).toBeCloseTo(0.08, 10);
  });
});
