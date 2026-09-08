/**
 * 掌握度规则的用例。
 *
 * 这套规则两端各跑一次、结果必须一致，所以它是纯函数而不是写库逻辑的一部分。
 * 用例除了盯边界，还钉住一个容易被后人「顺手优化」的决定：练习得分沿用 'quiz'
 * 这个来源值，不新增枚举。
 */
import { describe, expect, it } from 'vitest';
import { MASTERY_SOURCES } from '../enums';
import { applyMasterySignal, masteryToStatus, type MasteryState } from './mastery';

describe('masteryToStatus', () => {
  it('按 2.5 / 4.5 两个边界分档', () => {
    expect(masteryToStatus(4.5)).toBe('mastered');
    expect(masteryToStatus(4.49)).toBe('learning');
    expect(masteryToStatus(2.5)).toBe('learning');
    expect(masteryToStatus(2.49)).toBe('shaky');
    expect(masteryToStatus(0)).toBe('shaky');
  });
});

describe('applyMasterySignal', () => {
  it('首次客观得分与既有自评各占一半', () => {
    const current: MasteryState = { mastery: 2, masterySource: 'self' };
    const next = applyMasterySignal(current, { kind: 'practice', score: 4 });
    expect(next.mastery).toBeCloseTo(3, 10);
    expect(next.masterySource).toBe('quiz');
  });

  it('已有客观得分时新一次权重更高', () => {
    const current: MasteryState = { mastery: 2, masterySource: 'quiz' };
    const next = applyMasterySignal(current, { kind: 'practice', score: 4 });
    // 2 × 0.3 + 4 × 0.7 = 3.4
    expect(next.mastery).toBeCloseTo(3.4, 10);
  });

  it('自评标 mixed，不冒充客观得分', () => {
    const current: MasteryState = { mastery: 4, masterySource: 'quiz' };
    const next = applyMasterySignal(current, { kind: 'selfReport', mastery: 1 });
    expect(next.mastery).toBe(1);
    expect(next.masterySource).toBe('mixed');
  });

  it('练习得分按 1-5 收敛，自评按 0-5 收敛', () => {
    const from: MasteryState = { mastery: 3, masterySource: 'quiz' };
    expect(applyMasterySignal(from, { kind: 'practice', score: 99 }).mastery).toBeCloseTo(4.4, 10);
    expect(applyMasterySignal(from, { kind: 'selfReport', mastery: 99 }).mastery).toBe(5);
    expect(applyMasterySignal(from, { kind: 'selfReport', mastery: -1 }).mastery).toBe(0);
  });

  it('分数非法时退到下界，不产生 NaN 掌握度', () => {
    const from: MasteryState = { mastery: 3, masterySource: 'quiz' };
    const next = applyMasterySignal(from, { kind: 'practice', score: Number.NaN });
    expect(Number.isFinite(next.mastery)).toBe(true);
    // NaN 退到 1 分：3 × 0.3 + 1 × 0.7 = 1.6
    expect(next.mastery).toBeCloseTo(1.6, 10);
  });

  it('练习不新增 MasterySource 取值', () => {
    // 这是同步字段：加一个值会让尚未升级的手机端读到不认识的枚举
    expect(MASTERY_SOURCES).toEqual(['self', 'quiz', 'mixed']);
  });
});
