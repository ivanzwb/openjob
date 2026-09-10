/**
 * 掌握度的计算规则。
 *
 * 规则放 shared、写库只留一处（桌面在 src/main/practice/mastery.ts）。分开是因为
 * 这两件事失效的方式不同：规则抄两份会让两端对同一次作答算出不同的掌握度；写库
 * 抄两份会让「掌握度是怎么变成这个值的」查不出来，因为每处都可以再定一套 source。
 */

import type { MasterySource, NodeStatus } from '../enums';

export type MasterySignal =
  /** 一次有评分的练习，1-5 的客观得分 */
  | { kind: 'practice'; score: number }
  /** 对话里的自评，0-5 的绝对值 */
  | { kind: 'selfReport'; mastery: number };

export interface MasteryState {
  mastery: number;
  masterySource: MasterySource;
}

export function masteryToStatus(mastery: number): NodeStatus {
  if (mastery >= 4.5) return 'mastered';
  if (mastery >= 2.5) return 'learning';
  return 'shaky';
}

/**
 * 练习得分标 'quiz' 而不是新增一个来源值：MASTERY_SOURCES 是同步字段，加值会让
 * 尚未升级的手机端读到不认识的枚举。练习本来就是「考我」的通用化，语义没有变。
 */
export function applyMasterySignal(current: MasteryState, signal: MasterySignal): MasteryState {
  if (signal.kind === 'selfReport') {
    // 自评比答题得分弱，标 mixed 而非 quiz，避免污染客观分
    return { mastery: clamp(signal.mastery, 0, 5), masterySource: 'mixed' };
  }
  const score = clamp(signal.score, 1, 5);
  // 已经有过客观得分时，新一次的权重更高；否则与自评各占一半
  const mastery =
    current.masterySource === 'quiz'
      ? current.mastery * 0.3 + score * 0.7
      : current.mastery * 0.5 + score * 0.5;
  return { mastery, masterySource: 'quiz' };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
