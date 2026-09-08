/**
 * 重新生成讲解时用户临时提的要求（「多举例子」「重点讲 GC」这类）。
 * 桌面端与手机端各自本地生成，共用这段拼接避免两边措辞跑偏。
 *
 * 放在结构与档位要求之后：允许它改侧重和详略，但不能把输出结构带跑。
 */
export function userRequestBlock(instruction?: string): string {
  const text = instruction?.trim();
  if (!text) return '';
  return `
## 用户本次的额外要求（优先满足，但仍要遵守上面的输出结构与档位要求）
${text.slice(0, 800)}`;
}

/**
 * 讲解生成时注入的「已有考法」锚点：知识节点上若已生成过考我题，让讲解的
 * 「面试真实问法」与练习题库对齐，而不是凭空再编一套问法。
 * 桌面与手机各自查库后传值，措辞在这里保持唯一。
 */
export function quizAnchorBlock(quizQuestionMd?: string | null): string {
  const text = quizQuestionMd?.trim();
  if (!text) return '';
  return `
已有考法：${text.slice(0, 400)}（讲解的「面试真实问法」一节可与此对齐，不必照抄）`;
}
