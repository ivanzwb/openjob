/**
 * Prompt 追加要求与读回的用例。
 *
 * 读回这一侧的价值在于「挡住差异」：quiz 片段给 `question`、design 片段给
 * `scenarioMd`，字段名的历史包袱到适配层为止，不能扩散进评分引擎。所以用例逐个
 * 钉住这些别名——哪天有人删掉一个别名，坏的是旧题型的整条链路，而不是一个字段。
 */
import { describe, expect, it } from 'vitest';
import type { InterviewFormatDefinition } from '../plugins/types';
import { TEST_RUBRIC } from './__fixtures__/rubric';
import {
  practiceQuestionRequest,
  practiceScoreRepairRequest,
  practiceScoreRequest,
  readGeneratedEvaluation,
  readGeneratedQuestion,
} from './prompts';

const FORMAT: InterviewFormatDefinition = {
  id: 'test.knowledge',
  label: '技术知识问答',
  protocol: 'knowledge',
  defaultDurationMinutes: 20,
  followUpPolicy: { maxRounds: 2, strategy: 'adaptive' },
  rubricId: TEST_RUBRIC.id,
};

describe('practiceQuestionRequest', () => {
  it('首题只要一道，且不改片段已定的结构', () => {
    const text = practiceQuestionRequest({ format: FORMAT });
    expect(text).toContain('只出一道题');
    expect(text).toContain('不要额外加字段');
    expect(text).not.toContain('追问');
  });

  it('追问时带上轮次与上限，并明确不许换题', () => {
    const text = practiceQuestionRequest({ format: FORMAT, followUpRound: 2 });
    expect(text).toContain('第 2 轮追问');
    expect(text).toContain('上限 2 轮');
    expect(text).toContain('不要换新题');
  });

  it('用户本次要求追加在最后，优先级最低', () => {
    const text = practiceQuestionRequest({ format: FORMAT, userRequest: '请偏向分布式场景' });
    expect(text.trimEnd().endsWith('请偏向分布式场景')).toBe(true);
  });

  it('用户要求为空白时不留空行', () => {
    const text = practiceQuestionRequest({ format: FORMAT, userRequest: '   ' });
    expect(text).not.toContain('\n');
  });
});

describe('practiceScoreRequest', () => {
  it('逐个列出量规维度 ID，并禁止自造维度', () => {
    const text = practiceScoreRequest(TEST_RUBRIC);
    for (const dimension of TEST_RUBRIC.dimensions) {
      expect(text).toContain(dimension.id);
    }
    expect(text).toContain('不要自己造');
    expect(text).toContain('逐字照抄');
  });

  it('明确要求「没展开也要给分并引用原话」，堵住替候选人补话', () => {
    expect(practiceScoreRequest(TEST_RUBRIC)).toContain('不要替他补一句');
  });
});

describe('practiceScoreRepairRequest', () => {
  it('分别点名缺分维度与引文对不上的维度', () => {
    const text = practiceScoreRepairRequest({ missing: ['structure'], ungrounded: ['accuracy'] });
    expect(text).toContain('structure');
    expect(text).toContain('accuracy');
    expect(text).toContain('找不到');
  });

  it('只有一类问题时不输出另一类的空条目', () => {
    const text = practiceScoreRepairRequest({ missing: ['structure'], ungrounded: [] });
    expect(text).toContain('structure');
    expect(text).not.toContain('找不到');
  });
});

describe('readGeneratedQuestion', () => {
  it('兼容 quiz 的 question 与 design 的 scenarioMd', () => {
    expect(readGeneratedQuestion({ question: '讲讲 B+ 树' }).questionMd).toBe('讲讲 B+ 树');
    expect(readGeneratedQuestion({ scenarioMd: '设计一个短链服务' }).questionMd).toBe(
      '设计一个短链服务',
    );
  });

  it('没有 title 时用首行兜底，并去掉 Markdown 标题符号', () => {
    const question = readGeneratedQuestion({ questionMd: '## 索引下推\n\n请解释其作用。' });
    expect(question.title).toBe('索引下推');
  });

  it('题目为空或不是对象时报 unreadable-question', () => {
    expect(() => readGeneratedQuestion({ question: '  ' })).toThrowError(
      expect.objectContaining({ code: 'unreadable-question' }),
    );
    expect(() => readGeneratedQuestion(null)).toThrowError(
      expect.objectContaining({ code: 'unreadable-question' }),
    );
  });
});

describe('readGeneratedEvaluation', () => {
  it('兼容 feedback / improvedOutlineMd 这些旧字段名', () => {
    const result = readGeneratedEvaluation({
      feedback: '整体不错',
      improvedOutlineMd: '补上边界条件',
      dimensions: [{ dimensionId: 'accuracy', score: 4 }],
    });
    expect(result.feedbackMd).toBe('整体不错');
    expect(result.improvedScriptMd).toBe('补上边界条件');
    expect(result.dimensions).toHaveLength(1);
  });

  it('dimensions 不是数组时给空数组，交给评分引擎按缺分打回', () => {
    // 这里不抛错：让 groundDimensionScores 统一报出「缺了哪几维」，好让模型补一次
    expect(readGeneratedEvaluation({ dimensions: 'accuracy=4' }).dimensions).toEqual([]);
  });

  it('整体不是对象时报 missing-dimension', () => {
    expect(() => readGeneratedEvaluation('4 分')).toThrowError(
      expect.objectContaining({ code: 'missing-dimension' }),
    );
  });
});
