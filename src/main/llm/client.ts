import OpenAI from 'openai';
import type { LlmRole, LlmTier } from '@shared/enums';
import { getSecret, resolveEmbedding, resolveLlmRole, resolveLlmTier } from '../config';

export interface RoleClient {
  client: OpenAI;
  model: string;
  temperature: number | undefined;
  /** 实际命中的档位 */
  tier: LlmTier;
}

function buildClient(baseUrl: string, apiKeyRef: string): OpenAI {
  const apiKey = getSecret(apiKeyRef);
  if (!apiKey) {
    throw new Error(`provider 未配置 API Key，请在设置中填写`);
  }
  return new OpenAI({ baseURL: baseUrl, apiKey, maxRetries: 2 });
}

/**
 * 按档位创建客户端。调用方只说「我要 main / cheap 档」，
 * 用哪个 provider、哪个模型由配置决定。
 */
export function createTierClient(tier: LlmTier): RoleClient {
  const { baseUrl, model, apiKeyRef, temperature } = resolveLlmTier(tier);
  return {
    client: buildClient(baseUrl, apiKeyRef),
    model,
    temperature,
    tier,
  };
}

/**
 * 按角色创建客户端。角色先经配置映射到档位（未映射则落 main），
 * 再由档位决定 provider 与模型——这是模型分流控成本的前提。
 */
export function createRoleClient(role: LlmRole): RoleClient {
  const { tier, baseUrl, model, apiKeyRef, temperature } = resolveLlmRole(role);
  return {
    client: buildClient(baseUrl, apiKeyRef),
    model,
    temperature,
    tier,
  };
}

/** embedding 客户端：固定配置，不走档位选择 */
export function createEmbeddingClient(): OpenAI {
  const { baseUrl, apiKeyRef } = resolveEmbedding();
  return buildClient(baseUrl, apiKeyRef);
}
