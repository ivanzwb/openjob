export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

function systemText(content: ChatMessage['content']): string {
  return typeof content === 'string' ? content : '';
}

/**
 * 部分 OpenAI 兼容端点要求 system 只能出现在 messages[0]。
 */
export function normalizeChatMessages(messages: ChatMessage[]): ChatMessage[] {
  const systemParts: string[] = [];
  const rest: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = systemText(msg.content);
      if (text.trim()) systemParts.push(text);
      continue;
    }
    rest.push(msg);
  }

  if (systemParts.length === 0) return rest;
  return [{ role: 'system', content: systemParts.join('\n\n') }, ...rest];
}

/** 将 system 指令折叠进首条 user，供不支持 system 角色的端点回退 */
export function foldSystemIntoUser(messages: ChatMessage[]): ChatMessage[] {
  const normalized = normalizeChatMessages(messages);
  const [first, ...rest] = normalized;
  if (!first || first.role !== 'system') return normalized;

  const instruction = systemText(first.content);
  let folded = false;
  const out: ChatMessage[] = rest.map((msg) => {
    if (!folded && msg.role === 'user') {
      folded = true;
      return {
        role: 'user',
        content: `${instruction}\n\n---\n\n${systemText(msg.content)}`,
      };
    }
    return msg;
  });

  if (!folded) {
    out.unshift({ role: 'user', content: instruction });
  }
  return out;
}

export function isStrictSystemMessageError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /system message must be at the beginning/i.test(msg);
}
