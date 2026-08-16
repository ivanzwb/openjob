import type OpenAI from 'openai';
import type { LlmRole } from '@shared/enums';
import { parseJsonResponse } from '@shared/llm/parseJson';
import { resolvePrompt } from '@shared/prompts/registry';
import { getExperiment } from '../ab/experiments';
import { getFingerprint, recordPromptRun } from '../ab/promptRun';
import { createRoleClient } from './client';
import {
  foldSystemIntoUser,
  isStrictSystemMessageError,
  normalizeChatMessages,
} from './messages';

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** JD 诊断等结构化输出可能很长，给足 token 上限 */
const JSON_MAX_TOKENS = 16384;
/** 降档的下限：再低就装不下一份结构化输出，不如直接报错 */
const MIN_MAX_TOKENS = 2048;

function extractMessageText(
  message: OpenAI.Chat.Completions.ChatCompletionMessage | undefined,
): string | undefined {
  if (!message) return undefined;
  const parts = message.content as string | OpenAI.Chat.Completions.ChatCompletionContentPart[] | null;
  // 空串要当成「没有正文」，否则推理端点的兜底永远走不到
  if (typeof parts === 'string') return parts || undefined;
  if (Array.isArray(parts)) {
    const text = parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('');
    return text || undefined;
  }
  return undefined;
}

/** 推理端点（deepseek-reasoner 等）的思考过程，只在拿不到正文时当末位兜底 */
function extractReasoningText(
  message: OpenAI.Chat.Completions.ChatCompletionMessage | undefined,
): string | undefined {
  const reasoning = (message as { reasoning_content?: unknown } | undefined)?.reasoning_content;
  return typeof reasoning === 'string' && reasoning.trim() ? reasoning : undefined;
}

/**
 * 端点自己有更低的输出上限时会直接 400，比如 deepseek-chat 的
 * 「Invalid max_tokens value, the valid range of max_tokens is [1, 8192]」。
 *
 * 能从报错里读出上限就照它降；只说「must be <= 4096」甚至什么都不说的端点
 * 一律对折重试到 MIN_MAX_TOKENS 为止——别让整条流水线因为一个常量全军覆没。
 */
function lowerMaxTokensFor(err: unknown, current: number): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  if (!/max_tokens/i.test(msg)) return null;
  const range = /\[\s*\d+\s*,\s*(\d+)\s*\]/.exec(msg);
  const ceiling = range ? Number(range[1]) : NaN;
  if (Number.isFinite(ceiling) && ceiling > 0 && ceiling < current) return ceiling;
  const halved = Math.floor(current / 2);
  return halved >= MIN_MAX_TOKENS ? halved : null;
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
 *
 * 传 promptId 而不是直接传 system 文本：文本由 @shared/prompts/registry 解析，
 * AB 实验换版本只改注册表，调用点不变。params 只对 build 型 prompt 生效。
 */
export async function completeJson<T>(
  role: LlmRole,
  promptId: string,
  user: string,
  signal?: AbortSignal,
  params?: Record<string, string | undefined>,
): Promise<T> {
  const { client, model, temperature, tier } = createRoleClient(role);
  // AB 实验：按 promptId 查开关，按设备指纹稳定分流。未开启/拿不到指纹时退化为 v1。
  const experiment = getExperiment(promptId);
  const fingerprint = getFingerprint();
  const resolved = resolvePrompt(promptId, params, experiment, fingerprint);
  const startedAt = Date.now();

  const systemContent =
    resolved.text +
    '\n\n只输出合法 JSON，不要 markdown 代码块，不要任何解释文字。' +
    '字符串值里的双引号必须写成 \\"，换行必须写成 \\n。';

  const baseMessages = normalizeChatMessages([
    { role: 'system', content: systemContent },
    { role: 'user', content: user },
  ]);

  let raw: string | undefined;
  /** 只拿到思考过程时先记下来，所有 attempt 都失败后再用 */
  let reasoningRaw: string | undefined;
  let lastError: unknown;
  let lastUsage: { promptTokens?: number; completionTokens?: number } | undefined;
  let maxTokens = JSON_MAX_TOKENS;
  const attempts = buildAttempts(baseMessages);

  for (const attempt of attempts) {
    for (let retry = 0; retry < 2; retry++) {
      try {
        const res = await client.chat.completions.create(
          {
            model,
            temperature: temperature ?? 0.2,
            max_tokens: maxTokens,
            messages: attempt.messages,
            ...(attempt.useJsonFormat ? { response_format: { type: 'json_object' as const } } : {}),
          },
          { signal },
        );

        lastUsage = {
          promptTokens: res.usage?.prompt_tokens,
          completionTokens: res.usage?.completion_tokens,
        };

        const choice = res.choices[0];
        const text = extractMessageText(choice?.message)?.trim();
        if (text) {
          raw = text;
          break;
        }
        reasoningRaw ??= extractReasoningText(choice?.message)?.trim();

        const reason = choice?.finish_reason ?? 'unknown';
        lastError = new Error(`模型返回空内容 (finish_reason=${reason})`);
      } catch (err) {
        lastError = err;
        const lowered = lowerMaxTokensFor(err, maxTokens);
        if (lowered) {
          maxTokens = lowered;
          continue;
        }
        if (attempt.useJsonFormat && isUnsupportedJsonFormatError(err)) break;
        if (isStrictSystemMessageError(err)) break;
      }
    }
    if (raw) break;
  }

  // 正文一次都没拿到：推理端点偶尔把 JSON 留在思考过程里，值得试一次。
  // 撞 token 上限被截断的情况也落在这里，解析不出来会照常报错。
  if (!raw && reasoningRaw) raw = reasoningRaw;

  if (!raw) {
    const detail = lastError instanceof Error ? lastError.message : lastError ? String(lastError) : '未知原因';
    recordPromptRun({
      promptId,
      versionId: resolved.versionId,
      fingerprint: fingerprint ?? 'unknown',
      role,
      model,
      tier,
      ok: false,
      error: `模型未返回可用 JSON（${model}）：${detail}`,
      latencyMs: Date.now() - startedAt,
    });
    throw new Error(`模型未返回可用 JSON（${model}）：${detail}`);
  }

  try {
    const parsed = parseJsonResponse<T>(raw);
    recordPromptRun({
      promptId,
      versionId: resolved.versionId,
      fingerprint: fingerprint ?? 'unknown',
      role,
      model,
      tier,
      ok: true,
      promptTokens: lastUsage?.promptTokens,
      completionTokens: lastUsage?.completionTokens,
      latencyMs: Date.now() - startedAt,
      outputJson: raw,
    });
    return parsed;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    recordPromptRun({
      promptId,
      versionId: resolved.versionId,
      fingerprint: fingerprint ?? 'unknown',
      role,
      model,
      tier,
      ok: false,
      error: `JSON 解析失败：${detail}`,
      latencyMs: Date.now() - startedAt,
    });
    throw err;
  }
}
