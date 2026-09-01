import type { LlmRole } from '@shared/enums';
import {
  foldSystemIntoUser,
  isStrictSystemMessageError,
  normalizeChatMessages,
  type ChatMessage,
} from '@shared/llm/messages';
import {
  SALVAGE_TRUNCATED_PROMPTS,
  looksTruncated,
  parseJsonResponse,
} from '@shared/llm/parseJson';
import { resolvePrompt } from '@shared/prompts/registry';
import { resolveLlmRole } from './resolve';

/** JD 诊断等结构化输出可能很长，给足 token 上限 */
const JSON_MAX_TOKENS = 16384;
/** 降档的下限：再低就装不下一份结构化输出，不如直接报错 */
const MIN_MAX_TOKENS = 2048;

function isUnsupportedJsonFormatError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /response_format|json_object|json schema/i.test(msg);
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
  maxTokens: number,
  signal?: AbortSignal,
): Promise<{ text?: string; reasoningText?: string; finishReason?: string }> {
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
      max_tokens: maxTokens,
      ...(useJsonFormat ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string; reasoning_content?: string }; finish_reason?: string }[];
  };
  const choice = data.choices?.[0];
  return {
    text: choice?.message?.content?.trim() || undefined,
    // 推理端点（deepseek-reasoner 等）的思考过程，只在拿不到正文时当末位兜底
    reasoningText: choice?.message?.reasoning_content?.trim() || undefined,
    finishReason: choice?.finish_reason,
  };
}

export async function completeJson<T>(
  role: LlmRole,
  promptId: string,
  user: string,
  signal?: AbortSignal,
  params?: Record<string, string | undefined>,
): Promise<T> {
  const { baseUrl, model, apiKey, temperature } = await resolveLlmRole(role);
  const resolved = resolvePrompt(promptId, params);
  const systemContent =
    resolved.text +
    '\n\n只输出合法 JSON，不要 markdown 代码块，不要任何解释文字。' +
    '字符串值里的双引号必须写成 \\"，换行必须写成 \\n。';

  const baseMessages = normalizeChatMessages([
    { role: 'system', content: systemContent },
    { role: 'user', content: user },
  ]);

  /** 拿到过正文但没解析成功时留一份，用来给报错提供证据 */
  let unparsed: string | undefined;
  let unparsedFinishReason: string | undefined;
  /**
   * 解析成功但 finish_reason=length 的自闭合短截断：
   * 模型撞到输出上限，但 JSON 恰好收口，解析不出来「未闭合」所以被当成功放行，
   * 实际 markdown 是残缺的。先记下来继续试后面的配置，全试完还没有完整输出就抛截断错——
   * 宁可不给，也不能把它当完整讲解交出去。
   */
  let selfClosedLength: { text: string; parsed: T; finishReason: string } | undefined;
  /** 只拿到思考过程时先记下来，所有 attempt 都失败后再用 */
  let reasoningRaw: string | undefined;
  let lastError: unknown;
  let maxTokens = JSON_MAX_TOKENS;
  const attempts = buildAttempts(baseMessages);
  const parseOptions = { salvageTruncated: SALVAGE_TRUNCATED_PROMPTS.has(promptId) };

  for (const attempt of attempts) {
    for (let retry = 0; retry < 2; retry++) {
      try {
        const { text, reasoningText, finishReason } = await chatCompletion(
          baseUrl,
          apiKey,
          model,
          attempt.messages,
          temperature,
          attempt.useJsonFormat,
          maxTokens,
          signal,
        );
        if (text) {
          try {
            const parsed = parseJsonResponse<T>(text, parseOptions);
            // 自闭合短截断：finish_reason=length 且不是走抢救名单的 prompt 时，
            // 残缺 JSON 即使能解析出来（如讲解在中间断掉）也不能当完整输出静默交付。
            // 先记下继续试别的配置；后面有完整输出则优先。抢救名单的 prompt 本身就
            // 接受截断补全，length 是常态，仍按原样返回。
            if (finishReason === 'length' && !parseOptions.salvageTruncated) {
              selfClosedLength = { text, parsed, finishReason };
              lastError = new Error(
                `模型输出被截断（收到 ${text.length} 字符，finish_reason=${finishReason}），建议缩短输入后重试`,
              );
            } else {
              return parsed;
            }
          } catch (err) {
            // 解析不出来也算这次 attempt 失败。后面还有折叠 system、去掉
            // response_format 这些不同配置可以试——以前解析在整个循环之外，
            // 等于这些回退备着从来用不上，第一次拿到脏输出就直接抛。
            lastError = err;
            unparsed ??= text;
            unparsedFinishReason ??= finishReason;
            break; // 同一套配置重发只会拿到同样的东西，直接换下一套
          }
        }
        reasoningRaw ??= reasoningText;
        lastError = new Error(`模型返回空内容 (finish_reason=${finishReason ?? 'unknown'})`);
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
  }

  // 推理端点偶尔把 JSON 留在思考过程里，值得试一次
  if (reasoningRaw) {
    try {
      return parseJsonResponse<T>(reasoningRaw, parseOptions);
    } catch (err) {
      lastError = err;
    }
  }

  // 截断要单独说：以前一律抛「Unexpected end of input」，用户看不懂，我们也
  // 判断不了该缩短输入还是端点有问题
  if (unparsed && looksTruncated(unparsed)) {
    throw new Error(
      `模型输出被截断（收到 ${unparsed.length} 字符，finish_reason=${unparsedFinishReason ?? 'unknown'}），建议缩短输入后重试`,
    );
  }

  // 自闭合短截断：所有配置都撞 length 上限时，宁可报错也不能把残缺讲解当完整交付
  if (selfClosedLength) {
    throw new Error(
      `模型输出被截断（收到 ${selfClosedLength.text.length} 字符，finish_reason=${selfClosedLength.finishReason}），建议缩短输入后重试`,
    );
  }

  const detail =
    lastError instanceof Error ? lastError.message : lastError ? String(lastError) : '未知原因';
  throw new Error(`模型未返回可用 JSON（${model}）：${detail}`);
}
