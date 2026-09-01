/**
 * 考我 / 评分 prompt。桌面与手机两端文本完全一致，收拢为唯一事实源。
 *
 * 这三条原来只拿到「公司 + 岗位名 + 考点」，简历一个字都没有，模型要举例
 * 只能照着岗位名编候选人的经历。补简历上下文的同时，这里也要说清简历和 JD
 * 各是什么性质，否则简历给了也压不住模型往 JD 上靠。
 */

import { CODE_FENCE_RULE_IN_JSON } from './format';
import { QUESTION_GROUNDING_RULE, RESUME_GROUNDING_RULE, SCORE_GROUNDING_RULE } from './grounding';
import { INTERVIEW_INPUTS, buildStructuredPrompt } from './structure';

export const QUIZ_QUESTION_SYSTEM = buildStructuredPrompt({
  role: '你是面试官。',
  inputs: INTERVIEW_INPUTS,
  task: '根据考点出一道口头面试题，模拟真实追问压力。',
  rules: [QUESTION_GROUNDING_RULE, CODE_FENCE_RULE_IN_JSON],
  output: '输出 JSON：{ "question": "..." }',
});

export const QUIZ_SCORE_SYSTEM = buildStructuredPrompt({
  role: '你是面试评委。',
  inputs: INTERVIEW_INPUTS,
  task: '按 1-5 分评分（5=能扛追问），给出反馈和改进后的口语表述。',
  // 不给篇幅上限时，回答越长模型的改进稿越长，撞上输出 token 上限就是一份被截断
  // 的 JSON——整次评分连分数都拿不到。改进稿和参考答案是同一种东西，按同一个尺寸写。
  focus: [
    '- 反馈按点写，控制在 5 条以内，每条一两句话。',
    '- 改进稿是口语稿，控制在 60-90 秒能讲完的篇幅，不要整篇扩写成长文。',
  ].join('\n'),
  rules: [SCORE_GROUNDING_RULE, CODE_FENCE_RULE_IN_JSON],
  output:
    '输出 JSON：{ "score": 1-5, "feedbackMd": "...", "improvedScriptMd": "口语改进稿" }',
});

/**
 * 出完题就能看的参考答案，和评分时那份「改进话术」不是一回事：
 * 改进话术是把用户已经说过的内容改写一遍，答不上来时它什么也给不了；
 * 这份是照着题目直接给一个能背的范本，用来先看后练。
 *
 * 评分标准是「能扛追问」，参考答案就得按那个标准写——只给一段正确但平铺直叙的
 * 定义，用户照着背仍然过不了第二问。
 */
export const QUIZ_ANSWER_SYSTEM = buildStructuredPrompt({
  role: '你是资深面试官兼面试教练。',
  inputs: INTERVIEW_INPUTS,
  task: '针对这道考点题给出一份「参考答案」草稿（markdown），适合口头作答。',
  focus: [
    '- 结论先行，再展开原理，最后补 trade-off 或实际例子。',
    '- 按「能扛追问」的标准写：把面试官最可能追的那一两层提前答到。',
    '- 口语化，控制在 60-90 秒能讲完的篇幅。',
    '- 只写答案正文，不要写评分、点评或「以下是参考答案」这类开场白。',
  ].join('\n'),
  rules: [RESUME_GROUNDING_RULE, CODE_FENCE_RULE_IN_JSON],
  output: '输出 JSON：{ "answerMd": "..." }',
});
