/**
 * 评分校验的用例。
 *
 * 这里几乎每条都在盯同一件事：一个分数能不能被复核。掌握度、复练、优先级、当天
 * 计划全都以评分为输入，放行一条「找不到出处的 4 分」不是少一句引文，而是让后面
 * 所有推荐都建立在一个查不到来源的数字上。所以用例的重点不是「能打分」，而是
 * 「编造的引文必须被挡下来」。
 */
import { describe, expect, it } from 'vitest';
import { softwareEngineeringRolePack } from '../plugins/builtin/softwareEngineering';
import type { RolePack } from '../plugins/types';
import { ANSWER_MD, NO_THRESHOLD_RUBRIC, TEST_RUBRIC } from './__fixtures__/rubric';
import {
  groundDimensionScores,
  locateAnswerQuote,
  needsRePractice,
  resolvePracticeFormat,
  weightedTotalScore,
  type RawDimensionScore,
} from './rubric';
import { PracticeError } from './types';

const ACCURACY_QUOTE = 'B+ 树的非叶子节点只存键，所以扇出更大';
const STRUCTURE_QUOTE = '回表的代价来自随机 IO，覆盖索引可以避免。';

function raw(overrides: Partial<Record<string, RawDimensionScore>> = {}): RawDimensionScore[] {
  const base: Record<string, RawDimensionScore> = {
    accuracy: { dimensionId: 'accuracy', score: 4, answerQuote: ACCURACY_QUOTE, rationale: '说清了扇出' },
    structure: { dimensionId: 'structure', score: 3, answerQuote: STRUCTURE_QUOTE, rationale: '主线清楚' },
  };
  return Object.values({ ...base, ...overrides }).filter((item): item is RawDimensionScore => !!item);
}

describe('resolvePracticeFormat', () => {
  it('内置岗位包的每个题型都能解析出题型与量规', () => {
    for (const format of softwareEngineeringRolePack.interviewFormats) {
      const resolved = resolvePracticeFormat(softwareEngineeringRolePack, format.id);
      expect(resolved.format.id).toBe(format.id);
      expect(resolved.rubric.id).toBe(format.rubricId);
    }
  });

  it('题型不存在时报 unknown-format', () => {
    expect(() => resolvePracticeFormat(softwareEngineeringRolePack, 'se.nope')).toThrowError(
      expect.objectContaining({ code: 'unknown-format' }),
    );
  });

  it('题型引用了不存在的量规时报 unknown-rubric', () => {
    const broken: RolePack = { ...softwareEngineeringRolePack, rubrics: [] };
    const formatId = softwareEngineeringRolePack.interviewFormats[0].id;
    expect(() => resolvePracticeFormat(broken, formatId)).toThrowError(
      expect.objectContaining({ code: 'unknown-rubric' }),
    );
  });
});

describe('locateAnswerQuote', () => {
  it('逐字命中时返回原文下标', () => {
    const found = locateAnswerQuote(ANSWER_MD, ACCURACY_QUOTE);
    expect(found).not.toBeNull();
    expect(ANSWER_MD.slice(found!.start, found!.end)).toBe(ACCURACY_QUOTE);
  });

  it('只有空白差异时仍然命中，并回填原文里的真实片段', () => {
    // 模型经常把换行和缩进顺手抹平，这类引用不该被判成编造
    const reflowed = '回表的代价来自随机 IO，\n   覆盖索引可以避免。';
    const found = locateAnswerQuote(ANSWER_MD, reflowed);
    expect(found).not.toBeNull();
    expect(found!.quote).toBe(STRUCTURE_QUOTE);
    expect(ANSWER_MD.slice(found!.start, found!.end)).toBe(found!.quote);
  });

  it('把两处远隔的原话拼在一起定位不到', () => {
    // 忽略空白是为了容忍排版，不是为了容忍拼接：这两句中间隔着别的内容
    expect(locateAnswerQuote(ANSWER_MD, 'B+ 树的非叶子节点只存键，覆盖索引可以避免。')).toBeNull();
  });

  it('改写过的引文定位不到', () => {
    // 意思相同但不是原话——正是「看起来有据、实际不可复核」的那一类
    expect(locateAnswerQuote(ANSWER_MD, 'B+ 树的中间节点只保存键值，扇出因此更大')).toBeNull();
  });

  it('空引文不算命中', () => {
    expect(locateAnswerQuote(ANSWER_MD, '   ')).toBeNull();
  });
});

describe('groundDimensionScores', () => {
  it('每一维都有分且引文可定位时通过，并带上量规锚点原文', () => {
    const result = groundDimensionScores({ rubric: TEST_RUBRIC, answerMd: ANSWER_MD, raw: raw() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const accuracy = result.scores.find((item) => item.dimensionId === 'accuracy')!;
    expect(accuracy.score).toBe(4);
    expect(accuracy.weight).toBe(0.6);
    expect(accuracy.critical).toBe(true);
    // 锚点必须来自量规本身，不能是模型复述的
    expect(accuracy.anchor.text).toBe(TEST_RUBRIC.dimensions[0].anchors[4]);
    expect(accuracy.anchor.rubricId).toBe('test.rubric');
    expect(ANSWER_MD.slice(accuracy.answer.start, accuracy.answer.end)).toBe(accuracy.answer.quote);

    const structure = result.scores.find((item) => item.dimensionId === 'structure')!;
    expect(structure.critical).toBe(false);
    expect(structure.anchor.text).toBe(TEST_RUBRIC.dimensions[1].anchors[3]);
  });

  it('漏掉一个维度时整体打回，并点名是哪一维', () => {
    const result = groundDimensionScores({
      rubric: TEST_RUBRIC,
      answerMd: ANSWER_MD,
      raw: raw({ structure: undefined }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.missing).toEqual(['structure']);
    expect(result.failure.ungrounded).toEqual([]);
  });

  it('引文在原回答里找不到时算 ungrounded 而不是照单全收', () => {
    const result = groundDimensionScores({
      rubric: TEST_RUBRIC,
      answerMd: ANSWER_MD,
      raw: raw({
        accuracy: { dimensionId: 'accuracy', score: 5, answerQuote: '我还实现过一个 B+ 树存储引擎' },
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.ungrounded).toEqual(['accuracy']);
  });

  it('分数不是数字时按缺分处理，不猜一个默认值', () => {
    const result = groundDimensionScores({
      rubric: TEST_RUBRIC,
      answerMd: ANSWER_MD,
      raw: raw({ accuracy: { dimensionId: 'accuracy', score: '很好', answerQuote: ACCURACY_QUOTE } }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.missing).toEqual(['accuracy']);
  });

  it('越界分数收敛到 1-5', () => {
    const result = groundDimensionScores({
      rubric: TEST_RUBRIC,
      answerMd: ANSWER_MD,
      raw: raw({
        accuracy: { dimensionId: 'accuracy', score: 9, answerQuote: ACCURACY_QUOTE },
        structure: { dimensionId: 'structure', score: 0, answerQuote: STRUCTURE_QUOTE },
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scores.map((item) => item.score).sort()).toEqual([1, 5]);
  });

  it('量规里没有的维度直接忽略，不会混进结果', () => {
    const result = groundDimensionScores({
      rubric: TEST_RUBRIC,
      answerMd: ANSWER_MD,
      raw: [
        ...raw(),
        { dimensionId: 'charisma', score: 5, answerQuote: ACCURACY_QUOTE },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scores.map((item) => item.dimensionId)).toEqual(['accuracy', 'structure']);
  });
});

describe('weightedTotalScore', () => {
  it('按权重归一并保留两位小数', () => {
    const result = groundDimensionScores({ rubric: TEST_RUBRIC, answerMd: ANSWER_MD, raw: raw() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 4 × 0.6 + 3 × 0.4 = 3.6
    expect(weightedTotalScore(result.scores)).toBe(3.6);
  });

  it('没有维度时返回 0 而不是 NaN', () => {
    expect(weightedTotalScore([])).toBe(0);
  });
});

describe('needsRePractice', () => {
  function scoresOf(accuracy: number, structure: number) {
    const result = groundDimensionScores({
      rubric: TEST_RUBRIC,
      answerMd: ANSWER_MD,
      raw: raw({
        accuracy: { dimensionId: 'accuracy', score: accuracy, answerQuote: ACCURACY_QUOTE },
        structure: { dimensionId: 'structure', score: structure, answerQuote: STRUCTURE_QUOTE },
      }),
    });
    if (!result.ok) throw new Error('fixture 应当通过校验');
    return result.scores;
  }

  it('总分达标时不需要复练', () => {
    const scores = scoresOf(4, 3);
    expect(needsRePractice(TEST_RUBRIC, scores, weightedTotalScore(scores))).toBe(false);
  });

  it('总分低于阈值时需要复练', () => {
    const scores = scoresOf(2, 3);
    expect(needsRePractice(TEST_RUBRIC, scores, weightedTotalScore(scores))).toBe(true);
  });

  it('关键维度触底时即使总分够也要复练', () => {
    // 准确性为 1 却因为结构满分把总分拉到 2.6 以上——总分掩盖不了硬伤
    const scores = scoresOf(1, 5);
    expect(needsRePractice(TEST_RUBRIC, scores, 5)).toBe(true);
  });

  it('量规没写阈值时按 3 分判', () => {
    const scores = scoresOf(3, 2);
    expect(needsRePractice(NO_THRESHOLD_RUBRIC, scores, 2.6)).toBe(true);
    expect(needsRePractice(NO_THRESHOLD_RUBRIC, scores, 3)).toBe(false);
  });
});

describe('PracticeError', () => {
  it('带上 code 与 detail，供调用方分流', () => {
    const error = new PracticeError('empty-answer', '回答为空', 'sessionId=1');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('PracticeError');
    expect(error.code).toBe('empty-answer');
    expect(error.detail).toBe('sessionId=1');
  });
});
