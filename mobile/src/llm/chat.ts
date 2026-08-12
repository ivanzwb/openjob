import type { LlmRole } from '@shared/enums';
import { normalizeChatMessages, type ChatMessage } from '@shared/llm/messages';
import { resolveLlmRole } from './resolve';

export async function completeChat(
  role: LlmRole,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const { baseUrl, model, apiKey, temperature } = await resolveLlmRole(role);
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: normalizeChatMessages(messages),
      temperature: temperature ?? 0.3,
      stream: false,
    }),
    signal,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content?.trim() ?? '';
}
