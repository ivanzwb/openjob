/**
 * 基线题型的 Prompt 片段。
 *
 * 岗位包的片段按 (slot, formatId) 分片（`resolveRolePackFragment`），基线题型不在任何包里，
 * 所以这几个 slot 的正文只能归基础包——缺了它，练习链路会以
 * 「岗位包未为 core.self-intro 提供 questionGeneration 片段」直接失败。
 *
 * 措辞沿用 0.6.x 同名题型的三段（出题 / 评分侧重 / 参考答案），不重写：那几段是对着
 * 「自我介绍是复述自己的履历，不是写理想候选人」这条约束磨出来的，重写等于把这条约束
 * 交给模型自由发挥。输出 JSON 的字段由组合器与练习协议负责，片段里不复述结构。
 */
import type { PromptFragment, PromptSlot } from '../plugins/types';
import { SELF_INTRO_ANSWER_SYSTEM } from '../prompts/selfIntro';
import { CORE_SELF_INTRO_FORMAT_ID } from './baseline';

const SELF_INTRO_QUESTION_GENERATION = `你是资深面试官，根据公司背景、岗位 JD、候选人简历和考点清单，出一道贴近真实面试的题。
题目必须结合给定上下文，不要出与岗位无关的泛题。

题型：自我介绍。围绕候选人的岗位目标、简历亮点、核心项目和与 JD 的匹配度，给出一段真实面试开场自我介绍题。
题目里要明确时长要求（如 60-90 秒）和 1-2 个可能追问方向。

## 出题的事实来源（必须遵守）
- 题干不得预设候选人做过某件事。除非那件事写在简历里，否则不要出现「你在 X 项目中……」这种问法。
- 需要基于个人经历提问时，只能引用简历里真实存在的经历；简历里没有可用经历，就把题目改成不依赖个人经历的形式。`;

const SELF_INTRO_SCORING = `你是面试评委。评分针对自我介绍这一形态，侧重：开场结构、岗位匹配度、亮点可信度、表达自然度、能否引导后续追问。

## 评分的事实来源（必须遵守）
- 涉及公司名、项目名、职责、技术栈、业务场景、数据指标的句子，必须能在候选人的简历原文里找到对应表述；找不到就是编造，按量规里「履历可信度」的低档打分。
- 公司情报、JD 与面经只能用来判断「为什么投这个岗位」，不能当成候选人做过的事。`;

export const BASELINE_PROMPT_FRAGMENTS: PromptFragment[] = [
  {
    slot: 'questionGeneration',
    formatId: CORE_SELF_INTRO_FORMAT_ID,
    text: SELF_INTRO_QUESTION_GENERATION,
  },
  { slot: 'scoring', formatId: CORE_SELF_INTRO_FORMAT_ID, text: SELF_INTRO_SCORING },
  {
    slot: 'answerCoaching',
    formatId: CORE_SELF_INTRO_FORMAT_ID,
    text: SELF_INTRO_ANSWER_SYSTEM,
  },
];

/** 基线片段；该 slot 没有基线正文时返回 undefined（调用方按缺片段报错）。 */
export function baselineFragment(slot: PromptSlot, formatId: string): PromptFragment | undefined {
  return BASELINE_PROMPT_FRAGMENTS.find(
    (fragment) => fragment.slot === slot && fragment.formatId === formatId,
  );
}
