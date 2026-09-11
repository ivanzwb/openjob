import { describe, expect, it } from 'vitest';
import { REPORT_SOURCE_TYPES } from '../enums';
import {
  BASE_PROB_BOOST,
  CREDIBILITY_WEIGHT,
  RAW_TEXT_DEDUPE_PREFIX,
  boostedExamProb,
  corroborate,
  decideQuestionOutcome,
  type CorroborationSource,
} from './reportIngest';

describe('CREDIBILITY_WEIGHT', () => {
  /** 漏一个来源类型不会报错，只会让那类面经的修正幅度变成 undefined 参与算术 */
  it('每个面经来源都有权重', () => {
    for (const type of REPORT_SOURCE_TYPES) {
      expect(CREDIBILITY_WEIGHT[type]).toBeGreaterThan(0);
    }
    expect(Object.keys(CREDIBILITY_WEIGHT).sort()).toEqual([...REPORT_SOURCE_TYPES].sort());
  });

  it('一手复盘权重最高，网络抓取最低', () => {
    expect(CREDIBILITY_WEIGHT.selfDebrief).toBeGreaterThan(CREDIBILITY_WEIGHT.pasted);
    expect(CREDIBILITY_WEIGHT.pasted).toBeGreaterThan(CREDIBILITY_WEIGHT.web);
  });
});

describe('boostedExamProb', () => {
  it('按可信度权重抬升', () => {
    expect(boostedExamProb(0.3, 1)).toBeCloseTo(0.3 + BASE_PROB_BOOST, 10);
    expect(boostedExamProb(0.3, 0.5)).toBeCloseTo(0.3 + BASE_PROB_BOOST * 0.5, 10);
  });

  it('存疑来源的折扣系数一并生效', () => {
    expect(boostedExamProb(0.3, 1, 0.5)).toBeCloseTo(0.3 + BASE_PROB_BOOST * 0.5, 10);
  });

  it('概率封顶 1，再多面经也不会顶出值域', () => {
    expect(boostedExamProb(0.98, 1)).toBe(1);
    expect(boostedExamProb(1, 1)).toBe(1);
  });

  it('权重为 0 时原样返回，不因为一次无效摄入改动排序', () => {
    expect(boostedExamProb(0.42, 0)).toBe(0.42);
  });
});

function web(rawText: string): CorroborationSource {
  return { sourceType: 'web', rawText };
}

describe('corroborate', () => {
  it('一个来源都没有时按存疑折价', () => {
    expect(corroborate([])).toEqual({ sources: 0, factor: 0.5, verified: false });
  });

  it('只有单一网络来源时标为存疑', () => {
    expect(corroborate([web('三面问了 Kafka 的副本同步')])).toEqual({
      sources: 1,
      factor: 0.5,
      verified: false,
    });
  });

  it('两个独立来源都提到才给足权重', () => {
    const result = corroborate([web('问了副本同步'), web('考察了 ISR 收缩')]);
    expect(result).toEqual({ sources: 2, factor: 1, verified: true });
  });

  /** 洗稿与层层转载很常见，「被提到很多次」本身不说明问题 */
  it('同一篇原文重复摄入仍然只算一个来源', () => {
    const same = '一面问了 Kafka 的副本同步机制，二面问了索引下推';
    const result = corroborate([web(same), web(same), web(same)]);
    expect(result).toEqual({ sources: 1, factor: 0.5, verified: false });
  });

  it('判重只看前缀，后半段不同也算同一篇', () => {
    const head = 'x'.repeat(RAW_TEXT_DEDUPE_PREFIX);
    const result = corroborate([web(`${head}结尾甲`), web(`${head}结尾乙`)]);
    expect(result.sources).toBe(1);
    expect(result.verified).toBe(false);
  });

  it('前缀之内就有差异时算两个来源', () => {
    const head = 'x'.repeat(RAW_TEXT_DEDUPE_PREFIX - 1);
    const result = corroborate([web(`${head}甲`), web(`${head}乙`)]);
    expect(result.sources).toBe(2);
    expect(result.verified).toBe(true);
  });

  /** 一手经历不该因为「没人佐证」被折价 */
  it('自己复盘单独一条也算实证', () => {
    const result = corroborate([{ sourceType: 'selfDebrief', rawText: '我三面被问了这个' }]);
    expect(result).toEqual({ sources: 1, factor: 1, verified: true });
  });

  it('复盘与网络来源混在一起时仍按实证算', () => {
    const result = corroborate([
      web('某篇面经'),
      { sourceType: 'selfDebrief', rawText: '我确实被问到了' },
    ]);
    expect(result.verified).toBe(true);
    expect(result.factor).toBe(1);
  });

  it('来源类型不同不算同一篇，即使原文一样', () => {
    const same = '同样的一段话';
    const result = corroborate([web(same), { sourceType: 'pasted', rawText: same }]);
    expect(result.sources).toBe(2);
  });
});

describe('decideQuestionOutcome', () => {
  const existing = new Set(['Kafka 副本同步', '覆盖索引']);

  it('命中已有考点', () => {
    expect(
      decideQuestionOutcome(
        { questionIndex: 0, nodeName: 'Kafka 副本同步', confidence: 0.9 },
        existing,
      ),
    ).toEqual({ kind: 'matched', nodeName: 'Kafka 副本同步', confidence: 0.9 });
  });

  /** 模型可能报一个图谱里并不存在的名字，拿它继续往下走就会挂在一个空节点上 */
  it('模型报的考点名不在图谱里时按未命中处理', () => {
    expect(
      decideQuestionOutcome(
        { questionIndex: 0, nodeName: '并不存在的考点', confidence: 0.8 },
        existing,
      ),
    ).toEqual({ kind: 'unmatched', confidence: 0.8 });
  });

  it('名字不存在但给了建议名时建盲区考点', () => {
    expect(
      decideQuestionOutcome(
        {
          questionIndex: 0,
          nodeName: '并不存在的考点',
          confidence: 0.4,
          suggestedName: '事务隔离级别',
        },
        existing,
      ),
    ).toEqual({ kind: 'newBlindSpot', suggestedName: '事务隔离级别', confidence: 0.4 });
  });

  it('完全没有匹配结果时只留题，不动图谱', () => {
    expect(decideQuestionOutcome(undefined, existing)).toEqual({
      kind: 'unmatched',
      confidence: null,
    });
  });

  it('建议名只有空白时不建节点', () => {
    expect(
      decideQuestionOutcome(
        { questionIndex: 0, nodeName: null, confidence: 0.2, suggestedName: '   ' },
        existing,
      ),
    ).toEqual({ kind: 'unmatched', confidence: 0.2 });
  });

  it('建议名两端空白会被去掉', () => {
    const outcome = decideQuestionOutcome(
      { questionIndex: 0, nodeName: null, confidence: 0.3, suggestedName: '  事务隔离级别 ' },
      existing,
    );
    expect(outcome).toEqual({
      kind: 'newBlindSpot',
      suggestedName: '事务隔离级别',
      confidence: 0.3,
    });
  });

  /** 命中优先于建议名：模型两个都给时不该凭空多出一个重复考点 */
  it('同时命中并给了建议名时按命中算', () => {
    expect(
      decideQuestionOutcome(
        {
          questionIndex: 0,
          nodeName: '覆盖索引',
          confidence: 0.7,
          suggestedName: '索引下推',
        },
        existing,
      ),
    ).toEqual({ kind: 'matched', nodeName: '覆盖索引', confidence: 0.7 });
  });
});
