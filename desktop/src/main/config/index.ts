import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { CONFIG_VERSION, DEFAULT_CONFIG, type AppConfig } from '@core/config';
import type { LlmRole, LlmTier } from '@core/enums';

let cache: AppConfig | null = null;

function file(): string {
  return join(app.getPath('userData'), 'config.json');
}

/**
 * 旧版 llm.roles 形态：角色 → {providerId, model, temperature} 配置对象。
 * 新版形态：角色 → 档位名（tier 字符串）。由角色值类型区分。
 */
type PreTierRoleConfig = { providerId?: string; model?: string; temperature?: number };
type PreTierRoleSlice = Record<string, PreTierRoleConfig>;

function isPreTierRoles(value: unknown): value is PreTierRoleSlice {
  if (!value || typeof value !== 'object') return false;
  const first = Object.values(value as Record<string, unknown>)[0];
  return typeof first === 'object' && first !== null;
}

/**
 * 旧版主力档的角色名由旧版应用写死，其中可能包含后来归到岗位包的角色。
 * 这里不认识任何具体名字，只排除**已知不承担主力档**的三个：explain 是便宜档来源、
 * embedding 是固定配置、quiz 当年自成一档且从不提升。剩下的（岗位角色）就是主力档来源。
 */
const NON_MAIN_PRE_TIER_ROLES = new Set(['explain', 'embedding', 'quiz']);

function firstPreTierMainRole(roles: PreTierRoleSlice | null): PreTierRoleConfig | undefined {
  if (!roles) return undefined;
  for (const [name, value] of Object.entries(roles)) {
    if (NON_MAIN_PRE_TIER_ROLES.has(name)) continue;
    if (value && typeof value === 'object') return value;
  }
  return undefined;
}

/**
 * 与默认值做深合并。新版本新增的配置项在旧 config.json 上会自动补齐，
 * 用户已有的设置不被覆盖。
 */
function mergeDefaults(loaded: Partial<AppConfig>): AppConfig {
  const base = structuredClone(DEFAULT_CONFIG);
  const llmLoaded = loaded.llm;
  const preTierRoles = isPreTierRoles(llmLoaded?.roles) ? (llmLoaded!.roles as unknown as PreTierRoleSlice) : null;

  // 旧版把模型配置放在角色对象里：outline 是主力档的默认来源，explain 是便宜档的来源，
  // embedding 角色对应现在的固定配置。旧数据里主力档也可能记在别的角色名下，所以
  // outline 缺失时按 firstPreTierMainRole 兜底，不硬编码任何角色名。
  // 已有新结构的 tiers/embedding 优先（用户改过的不能丢）。
  const preTierMain = preTierRoles?.outline ?? firstPreTierMainRole(preTierRoles);
  const preTierCheap = preTierRoles?.explain;

  return {
    version: CONFIG_VERSION,
    llm: {
      providers: llmLoaded?.providers?.length ? llmLoaded.providers : base.llm.providers,
      tiers: {
        main: {
          ...base.llm.tiers.main,
          ...(preTierMain && !llmLoaded?.tiers?.main?.model
            ? {
                providerId: preTierMain.providerId ?? base.llm.tiers.main.providerId,
                model: preTierMain.model ?? '',
                temperature: preTierMain.temperature,
              }
            : {}),
          ...llmLoaded?.tiers?.main,
        },
        cheap: {
          ...base.llm.tiers.cheap,
          ...(preTierCheap && !llmLoaded?.tiers?.cheap?.model
            ? {
                providerId: preTierCheap.providerId ?? base.llm.tiers.cheap.providerId,
                model: preTierCheap.model ?? '',
                temperature: preTierCheap.temperature,
              }
            : {}),
          ...llmLoaded?.tiers?.cheap,
        },
      },
      // 旧版 roles 是配置对象，无法作为档位映射使用，整体丢弃（其模型配置已提升到 tiers）
      roles: preTierRoles ? { ...base.llm.roles } : { ...base.llm.roles, ...llmLoaded?.roles },
      embedding: {
        ...base.llm.embedding,
        ...(preTierRoles?.embedding && !llmLoaded?.embedding?.model
          ? {
              providerId: preTierRoles.embedding.providerId ?? base.llm.embedding.providerId,
              model: preTierRoles.embedding.model ?? '',
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
    // 主题的默认值只在字段缺失时生效：显式存过 'dark' 的老用户升级后仍是深色
    ui: { theme: loaded.ui?.theme ?? base.ui.theme },
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
 *
 * 角色未在 roles 映射中时落到 main 档；`undefined`（调用方拿不到岗位包声明的角色，
 * 例如没装声明它的包）同样落 main——所以这不影响调用能否成功。
 */
export function resolveLlmRole(role: LlmRole | undefined): {
  tier: keyof AppConfig['llm']['tiers'];
  baseUrl: string;
  model: string;
  apiKeyRef: string;
  temperature: number | undefined;
} {
  const config = getConfig();
  const tierName = (role === undefined ? undefined : config.llm.roles[role]) ?? 'main';
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
