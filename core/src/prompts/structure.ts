/**
 * system prompt 的统一骨架。
 *
 * 原来的 prompt 是几行自然语言堆在一起，角色、任务、约束、输出格式混在同一段，
 * 模型容易漏掉夹在中间的约束——尤其是「不要拿 JD 当经历」这种否定式要求，
 * 埋在句子中间基本等于没写。拆成带标题的小节后，约束有固定位置，加规则也
 * 不用再往长句里塞。
 *
 * 小节顺序是固定的：角色 → 输入 → 任务 → 侧重 → 约束 → 输出格式。
 * 先交代模型是谁、手上有什么，再说要干什么，最后才是格式——约束紧挨着输出，
 * 是因为离生成点越近越不容易被忽略。
 */
export interface PromptSections {
  /** 你是谁 */
  role: string;
  /** 上下文里会有哪些块，各自是什么性质（简历是事实、JD 是目标，这里点明） */
  inputs?: string;
  /** 要做什么 */
  task: string;
  /** 本题型/本档位额外侧重什么 */
  focus?: string;
  /** 硬约束，每条可以是多行文本（允许自带 ## 子标题） */
  rules?: string[];
  /** 输出格式，含 JSON schema */
  output: string;
}

const HEADINGS = {
  role: '# 角色',
  inputs: '# 输入',
  task: '# 任务',
  focus: '# 侧重',
  rules: '# 约束',
  output: '# 输出格式',
} as const;

export function buildStructuredPrompt(sections: PromptSections): string {
  const blocks: string[] = [
    `${HEADINGS.role}\n${sections.role.trim()}`,
  ];

  if (sections.inputs?.trim()) blocks.push(`${HEADINGS.inputs}\n${sections.inputs.trim()}`);
  blocks.push(`${HEADINGS.task}\n${sections.task.trim()}`);
  if (sections.focus?.trim()) blocks.push(`${HEADINGS.focus}\n${sections.focus.trim()}`);

  const rules = (sections.rules ?? []).map((r) => r.trim()).filter((r) => r.length > 0);
  if (rules.length > 0) blocks.push(`${HEADINGS.rules}\n${rules.join('\n\n')}`);

  blocks.push(`${HEADINGS.output}\n${sections.output.trim()}`);

  return blocks.join('\n\n');
}

/**
 * 面试类 prompt 共用的输入说明。
 *
 * 上下文里简历块和 JD 块是并排给的，不点明性质的话模型只看到一堆「候选人相关
 * 资料」。这段和 grounding 规则是一对：这里说清哪块是什么，那边说清能怎么用。
 */
export const INTERVIEW_INPUTS = `上下文里可能出现这些块，性质不同，不要混用：
- 「简历经历 / 简历项目 / 简历技能」：候选人真实做过的事，是唯一可信的个人经历来源。
- 「公司 / 岗位 / JD 摘要 / 公司技术栈 / 面试流程 / 公司热点」：目标岗位的要求与背景，候选人尚未做过。
- 「考点 / 覆盖类型 / 考察形式」：本次要练的知识点。
- 标注「（未提供）」的块表示该信息缺失，按缺失处理，不要用别的块补。`;
