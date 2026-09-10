/**
 * Story 口述对 Prompt 的补充：追加要求，和读回结果。
 *
 * 与练习引擎同一个做法：System Prompt 仍由岗位包片段（answerCoaching slot）决定，
 * 这里只往 userRequest 层追加「压到多长、只能用哪些事实」。Story 不自带 System
 * Prompt，否则岗位包对话术口吻的声明会被这条链路悄悄改写。
 *
 * 三档的差别只有 shape 这一句话。事实集合部分由 renderStoryFactSet 渲染，三档
 * 共用同一段文本——档位不同却能拿到不同事实，是这条链路最容易出现的退化。
 */

import { renderStoryFactSet, type DeliveryGroundingFailure, type StoryFactSet } from './factSet';
import { StoryError, type StoryDeliveryDuration } from './types';

export interface StoryDeliveryBudget {
  label: string;
  /** 口述正文的字数上限，按中文语速每秒 4~5 字估 */
  charBudget: number;
  /** 这一档该保留什么、该舍弃什么 */
  shape: string;
}

export const STORY_DELIVERY_BUDGETS: Record<StoryDeliveryDuration, StoryDeliveryBudget> = {
  30: {
    label: '30 秒',
    charBudget: 150,
    shape:
      '只讲一句情境、一句行动、一句结果，不要展开细节；结果里保留最能说明量级的那一个数字。',
  },
  60: {
    label: '60 秒',
    charBudget: 300,
    shape: '按 情境 → 我的任务 → 关键行动 → 结果 讲完整一轮，关键行动最多两点。',
  },
  120: {
    label: '2 分钟',
    charBudget: 600,
    shape:
      '完整讲 情境 → 任务 → 行动 → 结果 → 复盘，行动部分交代清楚取舍与理由，' +
      '结尾留一个可以被继续追问的钩子。',
  },
};

export interface StoryDeliveryRequestInput {
  factSet: StoryFactSet;
  duration: StoryDeliveryDuration;
}

export function storyDeliveryRequest(input: StoryDeliveryRequestInput): string {
  const budget = STORY_DELIVERY_BUDGETS[input.duration];
  return [
    renderStoryFactSet(input.factSet),
    '',
    `## 本次要求：把上面这段经历压成 ${budget.label} 的口述版本`,
    `- ${budget.shape}`,
    `- 正文控制在 ${budget.charBudget} 字以内，写成能直接说出口的话，不要小标题、不要项目符号；`,
    '- 事实只能来自上面的事实集合：数字、时间、人数、指标一个都不能新增或改写，' +
      '记不清的宁可不说；',
    '- 允许也应该做的是措辞加工：合并、删减、换更口语的说法；',
    '- 输出 JSON：{ "deliveryMd": "口述正文" }，不要额外字段。',
  ].join('\n');
}

export function storyDeliveryRepairRequest(failure: DeliveryGroundingFailure): string {
  return [
    '上一次输出没通过事实校验，请按同样的 JSON 结构重新输出一次完整口述：',
    `- 这些数字在事实集合里找不到：${failure.inventedNumbers.join('、')}；`,
    '- 请改用事实集合里真实存在的数字，或者把这句话里的数字整个去掉，不要换一个近似值。',
  ].join('\n');
}

export interface GeneratedDelivery {
  deliveryMd: string;
}

/** 容忍几种常见字段名：岗位包片段各自定过输出结构，读回的差异挡在这里 */
export function readGeneratedDelivery(raw: unknown): GeneratedDelivery {
  if (!raw || typeof raw !== 'object') {
    throw new StoryError('unreadable-delivery', '模型没有返回可用的口述版本');
  }
  const source = raw as Record<string, unknown>;
  for (const key of ['deliveryMd', 'contentMd', 'answerMd', 'scriptMd', 'answer']) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return { deliveryMd: value.trim() };
  }
  throw new StoryError(
    'unreadable-delivery',
    '模型返回的口述正文为空',
    Object.keys(source).join(','),
  );
}
