import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { CONFIG_VERSION, DEFAULT_CONFIG, type AppConfig } from '@shared/config';

let cache: AppConfig | null = null;

function file(): string {
  return join(app.getPath('userData'), 'config.json');
}

/**
 * 与默认值做深合并。新版本新增的配置项在旧 config.json 上会自动补齐，
 * 用户已有的设置不被覆盖。
 */
function mergeDefaults(loaded: Partial<AppConfig>): AppConfig {
  const base = structuredClone(DEFAULT_CONFIG);
  return {
    version: CONFIG_VERSION,
    llm: {
      providers: loaded.llm?.providers?.length ? loaded.llm.providers : base.llm.providers,
      roles: { ...base.llm.roles, ...loaded.llm?.roles },
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
    },
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
  return merged;
}

/** 按角色取出可直接发起调用所需的信息，找不到 provider 时给出可读错误 */
export function resolveLlmRole(role: keyof AppConfig['llm']['roles']): {
  baseUrl: string;
  model: string;
  apiKeyRef: string;
  temperature: number | undefined;
} {
  const config = getConfig();
  const roleConfig = config.llm.roles[role];
  const provider = config.llm.providers.find((p) => p.id === roleConfig.providerId);

  if (!provider) {
    throw new Error(`角色 ${role} 指向的 provider "${roleConfig.providerId}" 不存在，请在设置中检查`);
  }
  if (!provider.baseUrl) {
    throw new Error(`provider "${provider.id}" 未配置 baseUrl`);
  }
  if (!roleConfig.model) {
    throw new Error(`角色 ${role} 未选择模型`);
  }

  return {
    baseUrl: provider.baseUrl,
    model: roleConfig.model,
    apiKeyRef: provider.apiKeyRef,
    temperature: roleConfig.temperature,
  };
}

export * from './secrets';
