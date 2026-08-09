import type { LlmRole } from '@shared/enums';
import { createRoleClient } from './client';

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

  // 空内容/瞬时失败重试一次；解析逻辑与重试解耦，免得每次失败都重新组织消息
  let raw: string | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await client.chat.completions.create(
        {
          model,
          temperature: temperature ?? 0.2,
          messages: [
            {
              role: 'system',
              content:
                system +
                '\n\n只输出合法 JSON，不要 markdown 代码块，不要任何解释文字。',
            },
            { role: 'user', content: user },
          ],
          response_format: { type: 'json_object' },
        },
        { signal },
      );
      raw = res.choices[0]?.message?.content ?? undefined;
      if (raw) break;
    } catch (err) {
      lastError = err;
    }
  }

  if (!raw) {
    throw new Error(
      lastError ? `模型调用失败：${lastError instanceof Error ? lastError.message : String(lastError)}` : '模型未返回内容（已重试一次）',
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    // 部分兼容端点会在 JSON 外包裹 markdown fence，剥掉再试
    const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    return JSON.parse(stripped) as T;
  }
}
