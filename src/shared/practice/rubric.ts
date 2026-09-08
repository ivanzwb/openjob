/**
 * 评分引擎：把模型给出的维度分钉死在岗位包 rubric 与用户原回答上。
 *
 * 校验是 fail closed 的。放行一个「找不到出处的 4 分」看起来只是少一条引文，
 * 实际后果是掌握度被一个无法复核的数字改写，而复练、优先级和计划全都以掌握度
 * 为输入——错误会一路扩散到用户当天该学什么。
 */

import type {
  InterviewFormatDefinition,
  RolePack,
  RubricDefinition,
  RubricDimension,
  RubricScore,
} from '../plugins/types';
import {
  PracticeError,
  type PracticeAnswerCitation,
  type PracticeDimensionScore,
} from './types';

/** 模型给回的一条维度评分，字段名与 practicePrompts 里要求的一致 */
export interface RawDimensionScore {
  dimensionId?: unknown;
  score?: unknown;
  answerQuote?: unknown;
  rationale?: unknown;
}

export interface ResolvedPracticeFormat {
  format: InterviewFormatDefinition;
  rubric: RubricDefinition;
}

export function resolvePracticeFormat(
  rolePack: RolePack,
  formatId: string,
): ResolvedPracticeFormat {
  const format = rolePack.interviewFormats.find((item) => item.id === formatId);
  if (!format) {
    throw new PracticeError(
      'unknown-format',
      `岗位包 ${rolePack.manifest.id} 没有面试形式 ${formatId}`,
    );
  }
  const rubric = rolePack.rubrics.find((item) => item.id === format.rubricId);
  if (!rubric) {
    throw new PracticeError(
      'unknown-rubric',
      `面试形式 ${formatId} 引用的量规 ${format.rubricId} 不存在`,
    );
  }
  return { format, rubric };
}

function clampScore(value: unknown): RubricScore | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return null;
  const rounded = Math.min(5, Math.max(1, Math.round(numeric)));
  return rounded as RubricScore;
}

/**
 * 把原文压成「单空格分隔」并保留每个字符在原文里的下标。
 *
 * 模型引用时经常顺手改掉换行和缩进，逐字比较会把这类引用一律判成编造。折中是
 * 只允许空白差异：内容必须一字不差，位置仍然定位回原文。
 */
function normalizeWithIndex(text: string): { normalized: string; indices: number[] } {
  const chars: string[] = [];
  const indices: number[] = [];
  let previousWasSpace = true;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (/\s/.test(char)) {
      if (previousWasSpace) continue;
      chars.push(' ');
      indices.push(i);
      previousWasSpace = true;
      continue;
    }
    chars.push(char);
    indices.push(i);
    previousWasSpace = false;
  }
  while (chars.length > 0 && chars[chars.length - 1] === ' ') {
    chars.pop();
    indices.pop();
  }
  return { normalized: chars.join(''), indices };
}

/** 命中返回引文在原文中的区间；找不到说明这句话不是候选人说的 */
export function locateAnswerQuote(
  answerMd: string,
  quote: string,
): PracticeAnswerCitation | null {
  const trimmed = quote.trim();
  if (!trimmed) return null;

  const exact = answerMd.indexOf(trimmed);
  if (exact >= 0) {
    return { quote: trimmed, start: exact, end: exact + trimmed.length };
  }

  const answer = normalizeWithIndex(answerMd);
  const needle = normalizeWithIndex(trimmed).normalized;
  if (!needle) return null;
  const at = answer.normalized.indexOf(needle);
  if (at < 0) return null;

  const start = answer.indices[at];
  const end = answer.indices[at + needle.length - 1] + 1;
  return { quote: answerMd.slice(start, end), start, end };
}

export interface GroundingFailure {
  /** rubric 里有、模型没给分的维度 */
  missing: string[];
  /** 给了分但引文在原回答里找不到的维度 */
  ungrounded: string[];
}

export type GroundingResult =
  | { ok: true; scores: PracticeDimensionScore[] }
  | { ok: false; failure: GroundingFailure };

function anchorFor(dimension: RubricDimension, score: RubricScore): string {
  return dimension.anchors[score];
}

/**
 * 逐维度校验并组装。
 *
 * 返回失败而不是抛错：调用方要拿 missing/ungrounded 去让模型补一次，
 * 补不上才是错误。
 */
export function groundDimensionScores(input: {
  rubric: RubricDefinition;
  answerMd: string;
  raw: RawDimensionScore[];
}): GroundingResult {
  const { rubric, answerMd } = input;
  const byId = new Map<string, RawDimensionScore>();
  for (const item of input.raw) {
    const id = typeof item?.dimensionId === 'string' ? item.dimensionId.trim() : '';
    if (id) byId.set(id, item);
  }

  const scores: PracticeDimensionScore[] = [];
  const missing: string[] = [];
  const ungrounded: string[] = [];

  for (const dimension of rubric.dimensions) {
    const item = byId.get(dimension.id);
    const score = item ? clampScore(item.score) : null;
    if (!item || score === null) {
      missing.push(dimension.id);
      continue;
    }
    const quote = typeof item.answerQuote === 'string' ? item.answerQuote : '';
    const citation = locateAnswerQuote(answerMd, quote);
    if (!citation) {
      ungrounded.push(dimension.id);
      continue;
    }
    scores.push({
      dimensionId: dimension.id,
      label: dimension.label,
      weight: dimension.weight,
      critical: dimension.critical === true,
      score,
      anchor: {
        rubricId: rubric.id,
        dimensionId: dimension.id,
        score,
        text: anchorFor(dimension, score),
      },
      answer: citation,
      rationaleMd: typeof item.rationale === 'string' ? item.rationale.trim() : '',
    });
  }

  if (missing.length > 0 || ungrounded.length > 0) {
    return { ok: false, failure: { missing, ungrounded } };
  }
  return { ok: true, scores };
}

/** 权重和由 T01 的 contract 保证为 1，这里仍按实际权重归一，避免单点漂移放大 */
export function weightedTotalScore(scores: PracticeDimensionScore[]): number {
  const totalWeight = scores.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) return 0;
  const weighted = scores.reduce((sum, item) => sum + item.score * item.weight, 0);
  return Math.round((weighted / totalWeight) * 100) / 100;
}

export function needsRePractice(
  rubric: RubricDefinition,
  scores: PracticeDimensionScore[],
  totalScore: number,
): boolean {
  if (scores.some((item) => item.critical && item.score === 1)) return true;
  return totalScore < (rubric.passThreshold ?? 3);
}
