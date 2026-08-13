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
const JSON_MAX_TOKENS = 16384;

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
  // 部分推理端点（deepseek-reasoner / deepseek-v4-pro 等）把正文放进 reasoning_content 
  // content 为空但思考过程里有内容：兜底提取，parseJsonResponse 会再抽 JSON 片段
  // 避免误报「模型返回空内容 (finish_reason=length)」
  const reasoning = (message as { reasoning_content?: unknown }).reasoning_content;
  if (typeof reasoning === 'string' && reasoning.trim()) return reasoning;

  return undefined;
}

function isUnsupportedJsonFormatError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /response_format|json_object|json schema/i.test(msg);
}

function stripMarkdownFences(text: string): string {
  return text
    .replace(/^\uFEFF?```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

function extractJsonSlice(text: string): string {
  const objStart = text.indexOf('{');
  const objEnd = text.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) {
    return text.slice(objStart, objEnd + 1);
  }

  const arrStart = text.indexOf('[');
  const arrEnd = text.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd > arrStart) {
    return text.slice(arrStart, arrEnd + 1);
  }

  return text;
}

/** 修复模型在 JSON 字符串值里未转义的双引号、字面换行等常见问题 */
function repairJsonText(json: string): string {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < json.length; i++) {
    const ch = json[i]!;

    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      result += ch;
      if (inString) escaped = true;
      continue;
    }

    if (ch === '"') {
      if (!inString) {
        inString = true;
        result += ch;
        continue;
      }

      let j = i + 1;
      while (j < json.length && /\s/.test(json[j]!)) j++;
      const next = json[j];
      if (next === undefined || next === ':' || next === ',' || next === '}' || next === ']') {
        inString = false;
        result += ch;
      } else {
        result += '\\"';
      }
      continue;
    }

    if (inString) {
      if (ch === '\n') {
        result += '\\n';
        continue;
      }
      if (ch === '\r') {
        result += '\\r';
        continue;
      }
      if (ch === '\t') {
        result += '\\t';
        continue;
      }
    }

    result += ch;
  }

  return result.replace(/,\s*([}\]])/g, '$1');
}

function parseJsonResponse<T>(raw: string): T {
  const candidates = new Set<string>();
  const trimmed = raw.trim();
  const stripped = stripMarkdownFences(trimmed);
  const extracted = extractJsonSlice(stripped);

  for (const candidate of [trimmed, stripped, extracted]) {
    if (candidate) candidates.add(candidate);
  }

  let lastError: unknown;
  for (const candidate of candidates) {
    for (const attempt of [candidate, repairJsonText(candidate)]) {
      try {
        return JSON.parse(attempt) as T;
      } catch (err) {
        lastError = err;
      }
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`JSON 解析失败：${detail}`);
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

  return parseJsonResponse<T>(raw);
}
