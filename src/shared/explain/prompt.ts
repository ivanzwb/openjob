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
