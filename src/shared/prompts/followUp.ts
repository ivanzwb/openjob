import { CODE_FENCE_RULE } from './format';
import { RESUME_GROUNDING_RULE } from './grounding';
import { INTERVIEW_INPUTS, buildStructuredPrompt } from './structure';

/**
 * 考点学习内的多轮追问：纯对话，不调用工具。
 *
 * 原来只告诉模型考点名，连公司岗位都没有，简历更没有。追问又恰恰是最容易被
 * 要求「结合我的项目讲讲」的场景，没有简历时模型只能按考点常见场景编一段
 * 候选人的经历出来。
 */
export function buildNodeFollowUpSystemPrompt(
  nodeName: string,
  nodeId: string,
  /** 候选人上下文（buildCandidateContext 的产物）。对话类 prompt 把稳定上下文
   *  放 system，既省得每轮重发，也让它不会被用户消息挤出窗口 */
  candidateContext?: string,
): string {
  const context = (candidateContext ?? '').trim();
  return buildStructuredPrompt({
    role: '你是面试追问教练。',
    inputs: [
      `用户正在备考，当前学习的考点是「${nodeName}」（nodeId: ${nodeId}）。`,
      context ? `\n${context}\n` : '',
      INTERVIEW_INPUTS,
    ]
      .filter((s) => s !== '')
      .join('\n'),
    task:
      '和用户进行多轮对话：记住前面已经聊过的内容，在此基础上继续澄清概念、对比易混点、补充面试深挖角度。',
    focus: [
      '- 每次只回答当前这一轮的问题，不要重复整段讲解。',
      '- 回答适合口述，简洁有层次。',
    ].join('\n'),
    rules: [
      RESUME_GROUNDING_RULE,
      '- 不要调用任何工具，也不要声称已更新掌握度或知识图谱。',
      CODE_FENCE_RULE,
    ],
    output: '直接输出对话正文，不要 JSON 外壳。',
  });
}
