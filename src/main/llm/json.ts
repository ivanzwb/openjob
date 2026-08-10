import type OpenAI from 'openai';
import type { LlmRole } from '@shared/enums';
import { createRoleClient } from './client';
import {
  foldSystemIntoUser,
  isStrictSystemMessageError,
  normalizeChatMessages,
} from './messages';

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** JD 诊断等结构化输出可能很长，给足 token 上限 */
const JSON_MAX_TOKENS = 8192;

function extractMessageText(
  message: OpenAI.Chat.Completions.ChatCompletionMessage | undefined,
): string | undefined {
  if (!message) return undefined;
  const parts = message.content as string | OpenAI.Chat.Completions.ChatCompletionContentPart[] | null;
  if (typeof parts === 'string') return parts;
  if (Array.isArray(parts)) {
    const text = parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('');
    return text || undefined;
  }
  return undefined;
}

function isUnsupportedJsonFormatError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /response_format|json_object|json schema/i.test(msg);
}

interface JsonAttempt {
  messages: ChatMessage[];
  useJsonFormat: boolean;
  folded: boolean;
}

function buildAttempts(baseMessages: ChatMessage[]): JsonAttempt[] {
  const attempts: JsonAttempt[] = [];
  for (const folded of [false, true]) {
    const messages = folded ? foldSystemIntoUser(baseMessages) : baseMessages;
    for (const useJsonFormat of [true, false]) {
      attempts.push({ messages, useJsonFormat, folded });
    }
  }
  return attempts;
}

/**
 * 向模型请求 JSON 并解析。诊断流水线（解析 JD、建树、交叉分析）都走这条路，
 * 用 outline 角色——结构化输出、token 用量相对可控。
 */
export async function completeJson<T>(
  role: LlmRole,
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<T> {
  const { client, model, temperature } = createRoleClient(role);
  const systemContent =
    system + '\n\n只输出合法 JSON，不要 markdown 代码块，不要任何解释文字。';

  const baseMessages = normalizeChatMessages([
    { role: 'system', content: systemContent },
    { role: 'user', content: user },
  ]);

  let raw: string | undefined;
  let lastError: unknown;
  const attempts = buildAttempts(baseMessages);

  for (const attempt of attempts) {
    for (let retry = 0; retry < 2; retry++) {
      try {
        const res = await client.chat.completions.create(
          {
            model,
            temperature: temperature ?? 0.2,
            max_tokens: JSON_MAX_TOKENS,
            messages: attempt.messages,
            ...(attempt.useJsonFormat ? { response_format: { type: 'json_object' as const } } : {}),
          },
          { signal },
        );

        const choice = res.choices[0];
        const text = extractMessageText(choice?.message)?.trim();
        if (text) {
          raw = text;
          break;
        }

        const reason = choice?.finish_reason ?? 'unknown';
        lastError = new Error(`模型返回空内容 (finish_reason=${reason})`);
      } catch (err) {
        lastError = err;
        if (attempt.useJsonFormat && isUnsupportedJsonFormatError(err)) break;
        if (isStrictSystemMessageError(err)) break;
      }
    }
    if (raw) break;
  }

  if (!raw) {
    const detail = lastError instanceof Error ? lastError.message : lastError ? String(lastError) : '未知原因';
    throw new Error(`模型未返回可用 JSON（${model}）：${detail}`);
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    return JSON.parse(stripped) as T;
  }
}
