/**
 * 练习协议对 Prompt 的两件补充：追加要求，和读回结果。
 *
 * 题目与评分的正文仍然由岗位包片段决定（组合器只接受 Slot 片段，练习引擎不自带
 * System Prompt）。但片段的输出结构是按旧链路定的——quiz.score 只给一个总分，
 * design.score 连字段名都不一样。协议需要逐维度的分数、锚点和引文，所以：
 *
 * - 追加的要求走 userRequest 层，只增字段、不改片段已经定下的结构；
 * - 读回时容忍两套旧字段名，把差异挡在适配层里，不让它扩散到评分引擎。
 */

import type { InterviewFormatDefinition, RubricDefinition } from '../plugins/types';
import type { GroundingFailure, RawDimensionScore } from './rubric';
import { PracticeError } from './types';

export interface PracticeQuestionRequestInput {
  format: InterviewFormatDefinition;
  /** 第几轮追问，从 1 开始；省略表示出首题 */
  followUpRound?: number;
  userRequest?: string;
}

export function practiceQuestionRequest(input: PracticeQuestionRequestInput): string {
  const lines: string[] = [];
  if (input.followUpRound === undefined) {
    lines.push('本次只出一道题，输出结构沿用上面片段里要求的 JSON，不要额外加字段。');
  } else {
    lines.push(
      `这是第 ${input.followUpRound} 轮追问（上限 ${input.format.followUpPolicy.maxRounds} 轮）：` +
        '不要换新题，就着候选人刚才的作答往下追问一层，' +
        '输出结构仍沿用上面片段里要求的 JSON，把追问写进题干字段。',
    );
  }
  if (input.userRequest?.trim()) lines.push(input.userRequest.trim());
  return lines.join('\n');
}

/**
 * 逐维度评分的追加要求。
 *
 * 「必须逐字照抄」这条不写模型就会改写引文——改写过的句子在原回答里定位不到，
 * 评分引擎会整条打回，用户看到的是一次失败的评分而不是一次不可复核的评分。
 */
export function practiceScoreRequest(rubric: RubricDefinition): string {
  const ids = rubric.dimensions.map((dimension) => dimension.id).join('、');
  return [
    '除片段已经要求的字段外，本次还要输出 dimensions 数组，逐维度对照上面的评分量规打分：',
    '"dimensions": [{ "dimensionId": "维度 ID", "score": 1-5, "answerQuote": "候选人回答里的原句", "rationale": "为什么落在这一档" }]',
    `- 量规里的每个维度都要给一条，一条不能少：${ids}；`,
    '- dimensionId 只能用上面列出的 ID，不要自己造；',
    '- answerQuote 必须是候选人回答里真实存在的一段连续文字，逐字照抄，不要改写、不要翻译、不要把两处拼在一起；',
    '- 候选人在某个维度上确实没展开时照样给分，引用最能说明这一点的那句原话，不要替他补一句。',
  ].join('\n');
}

export function practiceScoreRepairRequest(failure: GroundingFailure): string {
  const lines = ['上一次输出没通过校验，请按同样的 JSON 结构重新输出一次完整结果：'];
  if (failure.missing.length > 0) {
    lines.push(`- 这些维度缺分或分数不合法：${failure.missing.join('、')}；`);
  }
  if (failure.ungrounded.length > 0) {
    lines.push(
      `- 这些维度的 answerQuote 在候选人回答里找不到：${failure.ungrounded.join('、')}；` +
        '请从候选人回答里原样复制一段连续文字，不要改写。',
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 读回
// ---------------------------------------------------------------------------

function textField(source: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export interface GeneratedQuestion {
  title: string;
  questionMd: string;
}

/** 首题走 quiz.question 的 `{question}`，其余题型走 design.case 的 `{title, scenarioMd}` */
export function readGeneratedQuestion(raw: unknown): GeneratedQuestion {
  if (!raw || typeof raw !== 'object') {
    throw new PracticeError('unreadable-question', '模型没有返回可用的题目');
  }
  const source = raw as Record<string, unknown>;
  const questionMd = textField(source, 'questionMd', 'question', 'scenarioMd', 'followUpMd');
  if (!questionMd) {
    throw new PracticeError(
      'unreadable-question',
      '模型返回的题目为空',
      Object.keys(source).join(','),
    );
  }
  const title = textField(source, 'title') || firstLine(questionMd);
  return { title, questionMd };
}

function firstLine(text: string): string {
  const line = text.split('\n').find((item) => item.trim()) ?? text;
  return line.replace(/^#+\s*/, '').trim().slice(0, 40);
}

export interface GeneratedEvaluation {
  feedbackMd: string;
  improvedScriptMd: string;
  dimensions: RawDimensionScore[];
}

export function readGeneratedEvaluation(raw: unknown): GeneratedEvaluation {
  if (!raw || typeof raw !== 'object') {
    throw new PracticeError('missing-dimension', '模型没有返回可用的评分结果');
  }
  const source = raw as Record<string, unknown>;
  const dimensions = Array.isArray(source['dimensions'])
    ? (source['dimensions'] as RawDimensionScore[])
    : [];
  return {
    feedbackMd: textField(source, 'feedbackMd', 'feedback'),
    improvedScriptMd: textField(source, 'improvedScriptMd', 'improvedOutlineMd', 'improvedMd'),
    dimensions,
  };
}
