import { describe, expect, it } from 'vitest';
import type {
  PracticeDimensionScore,
  PracticeEvaluation,
  PracticeSession,
  PracticeTurn,
} from '../practice/types';
import type { PracticeSessionStatus, PracticeTurnKind, PracticeTurnSpeaker } from '../enums';
import {
  derivePracticeView,
  sliceAnswerCitation,
  sortScoresByWeight,
  summarizeEvaluation,
} from './practiceState';

const ANSWER =
  '先澄清写入量级和一致性要求，再拆成接入层、订单核心和异步对账三块；订单核心用分库分表扛写入。';

function turn(
  index: number,
  speaker: PracticeTurnSpeaker,
  kind: PracticeTurnKind,
  contentMd: string,
): PracticeTurn {
  return { id: `t-${index}`, sessionId: 's-1', index, speaker, kind, contentMd, createdAt: index };
}

function session(
  turns: PracticeTurn[],
  overrides: { status?: PracticeSessionStatus; maxFollowUps?: number } = {},
): PracticeSession {
  return {
    id: 's-1',
    campaignId: 'c-1',
    nodeId: null,
    formatId: 'fmt-1',
    protocol: 'case',
    rubricId: 'rb-1',
    rolePackId: 'pack',
    rolePackVersion: '1.0.0',
    configSnapshotHash: 'hash',
    maxFollowUps: overrides.maxFollowUps ?? 3,
    followUpStrategy: 'adaptive',
    status: overrides.status ?? 'open',
    previousAttemptId: null,
    turns,
    createdAt: 1,
    updatedAt: 1,
  };
}

function score(overrides: Partial<PracticeDimensionScore> = {}): PracticeDimensionScore {
  const quote = overrides.answer?.quote ?? '分库分表';
  const start = ANSWER.indexOf(quote);
  return {
    dimensionId: 'architecture',
    label: '架构与数据流',
    weight: 0.3,
    critical: false,
    score: 4,
    anchor: { rubricId: 'rb-1', dimensionId: 'architecture', score: 4, text: '模块边界清晰' },
    answer: { quote, start, end: start + quote.length },
    rationaleMd: '拆分清楚',
    ...overrides,
  };
}

describe('derivePracticeView', () => {
  it('没有会话时返回 null，界面据此显示未开始', () => {
    expect(derivePracticeView(null)).toBeNull();
  });

  it('首问、最新提问和剩余追问轮次分开给出', () => {
    const view = derivePracticeView(
      session([
        turn(0, 'interviewer', 'question', '设计一个订单系统'),
        turn(1, 'candidate', 'answer', ANSWER),
        turn(2, 'interviewer', 'followUp', '分表键怎么选'),
      ]),
    )!;

    expect(view.questionMd).toBe('设计一个订单系统');
    expect(view.latestPromptMd).toBe('分表键怎么选');
    expect(view.followUpsAsked).toBe(1);
    expect(view.followUpsLeft).toBe(2);
    expect(view.canFollowUp).toBe(true);
    expect(view.canEvaluate).toBe(true);
    expect(view.closed).toBe(false);
  });

  it('turn 顺序以 index 为准，不依赖数组本身的顺序', () => {
    const view = derivePracticeView(
      session([
        turn(2, 'interviewer', 'followUp', '第二问'),
        turn(0, 'interviewer', 'question', '第一问'),
        turn(1, 'candidate', 'answer', ANSWER),
      ]),
    )!;

    expect(view.turns.map((item) => item.index)).toEqual([0, 1, 2]);
    expect(view.latestPromptMd).toBe('第二问');
  });

  it('追问到上限后不能再作答，但仍然可以提交评分', () => {
    const view = derivePracticeView(
      session(
        [
          turn(0, 'interviewer', 'question', '设计一个订单系统'),
          turn(1, 'candidate', 'answer', ANSWER),
          turn(2, 'interviewer', 'closing', '请整理最终作答后提交评分。'),
        ],
        { maxFollowUps: 1 },
      ),
    )!;

    expect(view.canFollowUp).toBe(false);
    expect(view.canEvaluate).toBe(true);
    expect(view.followUpsLeft).toBe(1);
  });

  it('已评分的会话既不能追问也不能重复评分', () => {
    const view = derivePracticeView(
      session([turn(0, 'interviewer', 'question', '设计一个订单系统')], { status: 'evaluated' }),
    )!;

    expect(view.closed).toBe(true);
    expect(view.canFollowUp).toBe(false);
    expect(view.canEvaluate).toBe(false);
  });
});

/**
 * 分数本身不可复核，可复核的是「按这条锚点、凭这句话给 4 分」。所以界面显示的是按
 * start/end 从作答里切回来的那段字，而不是模型自称引用的 quote——两者不一致时，
 * 用户必须看到自己真的写过的内容。
 */
describe('sliceAnswerCitation', () => {
  it('按偏移切回原文并带上前后文', () => {
    const start = ANSWER.indexOf('分库分表');
    const slice = sliceAnswerCitation(ANSWER, { quote: '分库分表', start, end: start + 4 }, 6);

    expect(slice.quote).toBe('分库分表');
    expect(slice.exact).toBe(true);
    expect(slice.before).toBe(ANSWER.slice(start - 6, start));
    expect(slice.after).toBe(ANSWER.slice(start + 4, start + 10));
  });

  it('模型给的引文与作答对不上时明说，而不是拿 quote 顶上', () => {
    const slice = sliceAnswerCitation(ANSWER, { quote: '用了消息队列', start: 0, end: 6 });

    expect(slice.exact).toBe(false);
    expect(slice.quote).toBe(ANSWER.slice(0, 6));
  });

  it('越界偏移收敛到作答范围内，不抛错也不产生负向切片', () => {
    const slice = sliceAnswerCitation('短答案', { quote: '短答案', start: -5, end: 999 });

    expect(slice.quote).toBe('短答案');
    expect(slice.exact).toBe(true);
    expect(slice.before).toBe('');
    expect(slice.after).toBe('');
  });

  it('start 大于 end 时不倒着切', () => {
    expect(sliceAnswerCitation(ANSWER, { quote: 'x', start: 10, end: 3 }).quote).toBe('');
  });
});

describe('sortScoresByWeight', () => {
  it('权重大的排前面，同权重按维度 ID 稳定排序', () => {
    const scores = [
      score({ dimensionId: 'b', weight: 0.2 }),
      score({ dimensionId: 'a', weight: 0.2 }),
      score({ dimensionId: 'c', weight: 0.6 }),
    ];

    expect(sortScoresByWeight(scores).map((item) => item.dimensionId)).toEqual(['c', 'a', 'b']);
  });
});

describe('summarizeEvaluation', () => {
  function evaluation(scores: PracticeDimensionScore[], overrides: Partial<PracticeEvaluation> = {}): PracticeEvaluation {
    return {
      attemptId: 'a-1',
      sessionId: 's-1',
      campaignId: 'c-1',
      nodeId: null,
      formatId: 'fmt-1',
      rubricId: 'rb-1',
      scores,
      totalScore: 3.44,
      feedbackMd: '',
      improvedScriptMd: '',
      needsRePractice: false,
      mastery: null,
      createdAt: 1,
      ...overrides,
    };
  }

  it('总分保留一位小数，触底的关键维度单独列出来', () => {
    const summary = summarizeEvaluation(
      evaluation([
        score({ dimensionId: 'critical-low', critical: true, score: 1 }),
        score({ dimensionId: 'critical-ok', critical: true, score: 4 }),
        score({ dimensionId: 'plain-low', critical: false, score: 1 }),
      ]),
      ANSWER,
    );

    expect(summary.totalLabel).toBe('3.4 / 5');
    expect(summary.criticalMisses.map((item) => item.dimensionId)).toEqual(['critical-low']);
  });

  it('引文对不上作答的维度会被点名，用户知道哪个分数没有依据', () => {
    const summary = summarizeEvaluation(
      evaluation([
        score({ dimensionId: 'grounded' }),
        score({
          dimensionId: 'ungrounded',
          answer: { quote: '这句话作答里没有', start: 0, end: 8 },
        }),
      ]),
      ANSWER,
    );

    expect(summary.ungroundedDimensionIds).toEqual(['ungrounded']);
  });
});
