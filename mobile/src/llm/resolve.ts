import type { AppConfig } from '@shared/config';
import type { LlmRole, LlmTier } from '@shared/enums';
import { getMobileConfig, getMobileSecret } from '../config/settings';

export interface ResolvedLlm {
  tier: LlmTier;
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number | undefined;
}

async function resolveTier(tier: LlmTier): Promise<ResolvedLlm> {
  const config = getMobileConfig();
  const tierConfig = config.llm.tiers[tier];
  const provider = config.llm.providers.find((p) => p.id === tierConfig.providerId);

  if (!provider) {
    throw new Error(`档位 ${tier} 指向的 provider "${tierConfig.providerId}" 不存在，请同步设置`);
  }
  if (!provider.baseUrl) {
    throw new Error(`provider "${provider.id}" 未配置 baseUrl`);
  }
  if (!tierConfig.model) {
    throw new Error(`档位 ${tier} 未选择模型`);
  }

  const apiKey = await getMobileSecret(provider.apiKeyRef);
  if (!apiKey) {
    throw new Error('未配置 API Key，请先在桌面端设置并同步');
  }

  return {
    tier,
    baseUrl: provider.baseUrl,
    model: tierConfig.model,
    apiKey,
    temperature: tierConfig.temperature,
  };
}

export async function resolveLlmRole(role: LlmRole): Promise<ResolvedLlm> {
  const config = getMobileConfig();
  const tierName = config.llm.roles[role] ?? 'main';
  return resolveTier(tierName);
}
