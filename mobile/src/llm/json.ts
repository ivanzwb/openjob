import type { LlmRole } from '@shared/enums';
import {
  foldSystemIntoUser,
  isStrictSystemMessageError,
  normalizeChatMessages,
  type ChatMessage,
} from '@shared/llm/messages';
import { parseJsonResponse } from '@shared/llm/parseJson';
import { resolveLlmRole } from './resolve';

const JSON_MAX_TOKENS = 8192;

function isUnsupportedJsonFormatError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /response_format|json_object|json schema/i.test(msg);
}

interface JsonAttempt {
  messages: ChatMessage[];
  useJsonFormat: boolean;
}

function buildAttempts(baseMessages: ChatMessage[]): JsonAttempt[] {
  const attempts: JsonAttempt[] = [];
  for (const folded of [false, true]) {
    const messages = folded ? foldSystemIntoUser(baseMessages) : baseMessages;
    for (const useJsonFormat of [true, false]) {
      attempts.push({ messages, useJsonFormat });
    }
  }
  return attempts;
}

async function chatCompletion(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  temperature: number | undefined,
  useJsonFormat: boolean,
  signal?: AbortSignal,
): Promise<{ text?: string; finishReason?: string }> {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: temperature ?? 0.2,
      max_tokens: JSON_MAX_TOKENS,
      ...(useJsonFormat ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string; reasoning_content?: string }; finish_reason?: string }>;
  };
  const choice = data.choices?.[0];
  // 推理端点（deepseek-reasoner / deepseek-v4-pro 等）把正文放进 reasoning_content，
  // content 为空时兜底提取，避免误报「模型返回空内容 (finish_reason=length)」
  const contentText = choice?.message?.content?.trim();
  const reasoningText = choice?.message?.reasoning_content?.trim();
  return {
    text: contentText || reasoningText || undefined,
    finishReason: choice?.finish_reason,
  };
}

export async function completeJson<T>(
  role: LlmRole,
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<T> {
  const { baseUrl, model, apiKey, temperature } = await resolveLlmRole(role);
  const systemContent =
    system +
    '\n\n只输出合法 JSON，不要 markdown 代码块，不要任何解释文字。' +
    '字符串值里的双引号必须写成 \\"，换行必须写成 \\n。';

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
        const { text, finishReason } = await chatCompletion(
          baseUrl,
          apiKey,
          model,
          attempt.messages,
          temperature,
          attempt.useJsonFormat,
          signal,
        );
        if (text) {
          raw = text;
          break;
        }
        lastError = new Error(`模型返回空内容 (finish_reason=${finishReason ?? 'unknown'})`);
      } catch (err) {
        lastError = err;
        if (attempt.useJsonFormat && isUnsupportedJsonFormatError(err)) break;
        if (isStrictSystemMessageError(err)) break;
      }
    }
    if (raw) break;
  }

  if (!raw) {
    const detail =
      lastError instanceof Error ? lastError.message : lastError ? String(lastError) : '未知原因';
    throw new Error(`模型未返回可用 JSON（${model}）：${detail}`);
  }

  return parseJsonResponse<T>(raw);
}
