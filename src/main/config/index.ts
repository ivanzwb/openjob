import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { CONFIG_VERSION, DEFAULT_CONFIG, type AppConfig } from '@shared/config';
import type { LlmRole, LlmTier } from '@shared/enums';

let cache: AppConfig | null = null;

function file(): string {
  return join(app.getPath('userData'), 'config.json');
}

/**
 * 旧版 llm.roles 形态：角色 → {providerId, model, temperature} 配置对象。
 * 新版形态：角色 → 档位名（tier 字符串）。由角色值类型区分。
 */
type LegacyRoleSlice = {
  outline?: { providerId?: string; model?: string; temperature?: number };
  explain?: { providerId?: string; model?: string; temperature?: number };
  codeAgent?: { providerId?: string; model?: string; temperature?: number };
  quiz?: { providerId?: string; model?: string; temperature?: number };
  embedding?: { providerId?: string; model?: string };
};

function isLegacyRoles(value: unknown): value is LegacyRoleSlice {
  if (!value || typeof value !== 'object') return false;
  const first = Object.values(value as Record<string, unknown>)[0];
  return typeof first === 'object' && first !== null;
}

/**
 * 与默认值做深合并。新版本新增的配置项在旧 config.json 上会自动补齐，
 * 用户已有的设置不被覆盖。
 */
function mergeDefaults(loaded: Partial<AppConfig>): AppConfig {
  const base = structuredClone(DEFAULT_CONFIG);
  const llmLoaded = loaded.llm;
  const legacyRoles = isLegacyRoles(llmLoaded?.roles) ? (llmLoaded!.roles as unknown as LegacyRoleSlice) : null;

  // 旧版把模型配置放在角色对象里：outline 是主力档的默认来源，explain 是便宜档的来源，
  // embedding 角色对应现在的固定配置。已有新结构的 tiers/embedding 优先（用户改过的不能丢）。
  const legacyMain = legacyRoles?.outline ?? legacyRoles?.codeAgent;
  const legacyCheap = legacyRoles?.explain;

  return {
    version: CONFIG_VERSION,
    llm: {
      providers: llmLoaded?.providers?.length ? llmLoaded.providers : base.llm.providers,
      tiers: {
        main: {
          ...base.llm.tiers.main,
          ...(legacyMain && !llmLoaded?.tiers?.main?.model
            ? {
                providerId: legacyMain.providerId ?? base.llm.tiers.main.providerId,
                model: legacyMain.model ?? '',
                temperature: legacyMain.temperature,
              }
            : {}),
          ...llmLoaded?.tiers?.main,
        },
        cheap: {
          ...base.llm.tiers.cheap,
          ...(legacyCheap && !llmLoaded?.tiers?.cheap?.model
            ? {
                providerId: legacyCheap.providerId ?? base.llm.tiers.cheap.providerId,
                model: legacyCheap.model ?? '',
                temperature: legacyCheap.temperature,
              }
            : {}),
          ...llmLoaded?.tiers?.cheap,
        },
      },
      // 旧版 roles 是配置对象，无法作为档位映射使用，整体丢弃（其模型配置已提升到 tiers）
      roles: legacyRoles ? { ...base.llm.roles } : { ...base.llm.roles, ...llmLoaded?.roles },
      embedding: {
        ...base.llm.embedding,
        ...(legacyRoles?.embedding && !llmLoaded?.embedding?.model
          ? {
              providerId: legacyRoles.embedding.providerId ?? base.llm.embedding.providerId,
              model: legacyRoles.embedding.model ?? '',
            }
          : {}),
        ...llmLoaded?.embedding,
      },
    },
    search: {
      providers: {
        bocha: { ...base.search.providers.bocha, ...loaded.search?.providers?.bocha },
        tavily: { ...base.search.providers.tavily, ...loaded.search?.providers?.tavily },
      },
      routing: loaded.search?.routing?.length ? loaded.search.routing : base.search.routing,
      defaultProvider: loaded.search?.defaultProvider ?? base.search.defaultProvider,
      domainCredibility: {
        ...base.search.domainCredibility,
        ...loaded.search?.domainCredibility,
      },
      cacheTtlDays: { ...base.search.cacheTtlDays, ...loaded.search?.cacheTtlDays },
      techDocStaleDays: loaded.search?.techDocStaleDays ?? base.search.techDocStaleDays,
    },
    priority: {
      ...base.priority,
      ...loaded.priority,
      coverageBoost: { ...base.priority.coverageBoost, ...loaded.priority?.coverageBoost },
      targetMastery: { ...base.priority.targetMastery, ...loaded.priority?.targetMastery },
    },
    update: { ...base.update, ...loaded.update },
  };
}

export function getConfig(): AppConfig {
  if (cache) return cache;

  const path = file();
  if (!existsSync(path)) {
    cache = structuredClone(DEFAULT_CONFIG);
    writeFileSync(path, JSON.stringify(cache, null, 2), 'utf8');
    return cache;
  }

  try {
    const loaded = JSON.parse(readFileSync(path, 'utf8')) as Partial<AppConfig>;
    cache = mergeDefaults(loaded);
  } catch {
    // 配置损坏时回落到默认值，不阻塞启动
    cache = structuredClone(DEFAULT_CONFIG);
  }
  return cache;
}

export function updateConfig(next: AppConfig): AppConfig {
  const merged = mergeDefaults(next);
  cache = merged;
  writeFileSync(file(), JSON.stringify(merged, null, 2), 'utf8');
  import('./syncMirror').then(({ mirrorAppSettings }) => mirrorAppSettings()).catch(() => {});
  return merged;
}

/**
 * 按档位取出可直接发起调用所需的信息：档位 → provider。
 */
export function resolveLlmTier(tier: LlmTier): {
  baseUrl: string;
  model: string;
  apiKeyRef: string;
  temperature: number | undefined;
} {
  const config = getConfig();
  const tierConfig = config.llm.tiers[tier];
  const provider = config.llm.providers.find((p) => p.id === tierConfig.providerId);

  if (!provider) {
    throw new Error(`档位 ${tier} 指向的 provider "${tierConfig.providerId}" 不存在，请在设置中检查`);
  }
  if (!provider.baseUrl) {
    throw new Error(`provider "${provider.id}" 未配置 baseUrl`);
  }
  if (!tierConfig.model) {
    throw new Error(`档位 ${tier} 未选择模型`);
  }

  return {
    baseUrl: provider.baseUrl,
    model: tierConfig.model,
    apiKeyRef: provider.apiKeyRef,
    temperature: tierConfig.temperature,
  };
}

/**
 * 按角色取出可直接发起调用所需的信息：角色 → 档位 → provider。
 * 角色未在 roles 映射中时落到 main 档。
 */
export function resolveLlmRole(role: LlmRole): {
  tier: keyof AppConfig['llm']['tiers'];
  baseUrl: string;
  model: string;
  apiKeyRef: string;
  temperature: number | undefined;
} {
  const config = getConfig();
  const tierName = config.llm.roles[role] ?? 'main';
  const tierConfig = config.llm.tiers[tierName];
  const provider = config.llm.providers.find((p) => p.id === tierConfig.providerId);

  if (!provider) {
    throw new Error(`档位 ${tierName} 指向的 provider "${tierConfig.providerId}" 不存在，请在设置中检查`);
  }
  if (!provider.baseUrl) {
    throw new Error(`provider "${provider.id}" 未配置 baseUrl`);
  }
  if (!tierConfig.model) {
    throw new Error(`档位 ${tierName} 未选择模型（角色 ${role} 走这一档）`);
  }

  return {
    tier: tierName,
    baseUrl: provider.baseUrl,
    model: tierConfig.model,
    apiKeyRef: provider.apiKeyRef,
    temperature: tierConfig.temperature,
  };
}

/** embedding 的固定配置。不参与档位选择——换模型会使已有向量全部失效。 */
export function resolveEmbedding(): {
  baseUrl: string;
  model: string;
  apiKeyRef: string;
} {
  const config = getConfig();
  const emb = config.llm.embedding;
  const provider = config.llm.providers.find((p) => p.id === emb.providerId);

  if (!provider) {
    throw new Error(`embedding 指向的 provider "${emb.providerId}" 不存在，请在设置中检查`);
  }
  if (!provider.baseUrl) {
    throw new Error(`provider "${provider.id}" 未配置 baseUrl`);
  }
  if (!emb.model) {
    throw new Error('embedding 未选择模型');
  }

  return {
    baseUrl: provider.baseUrl,
    model: emb.model,
    apiKeyRef: provider.apiKeyRef,
  };
}

export * from './secrets';
