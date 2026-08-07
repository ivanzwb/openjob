import OpenAI from 'openai';
import type { LlmRole } from '@shared/enums';
import { getSecret, resolveLlmRole } from '../config';

export interface RoleClient {
  client: OpenAI;
  model: string;
  temperature: number | undefined;
}

/**
 * 按角色创建客户端。调用方只说「我是 explain 角色」，
 * 用哪个 provider、哪个模型由配置决定——这是模型分流控成本的前提。
 */
export function createRoleClient(role: LlmRole): RoleClient {
  const { baseUrl, model, apiKeyRef, temperature } = resolveLlmRole(role);
  const apiKey = getSecret(apiKeyRef);
  if (!apiKey) {
    throw new Error(`角色 ${role} 使用的 provider 未配置 API Key，请在设置中填写`);
  }

  return {
    client: new OpenAI({ baseURL: baseUrl, apiKey, maxRetries: 2 }),
    model,
    temperature,
  };
}
