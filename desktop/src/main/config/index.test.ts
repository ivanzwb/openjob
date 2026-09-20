/**
 * 配置合并与角色解析。
 *
 * 钉住两件容易悄悄改坏的事：旧版（pre-tier）配置怎么迁成新的 tiers/roles，
 * 以及拿不到角色（岗位包没声明、或没装）时落在哪一档。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_VERSION, DEFAULT_CONFIG, V1_SEARCH_DEFAULTS, type AppConfig } from '@core/config';
import type { LlmRole, LlmTier } from '@core/enums';

/** 只声明用得到的两个出口：动态 import 的模块类型不许写成 typeof import(...) */
interface ConfigModule {
  getConfig: () => AppConfig;
  resolveLlmRole: (role: LlmRole | undefined) => { tier: LlmTier; model: string };
}

const state = { userData: '' };

vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8'),
  },
}));

/** 一份可用配置：resolveLlmRole 要求命中档位必须已经选了模型 */
const USABLE_LLM = {
  providers: [{ id: 'p', label: 'P', baseUrl: 'https://example.test/v1', apiKeyRef: 'llm.p' }],
  tiers: {
    main: { providerId: 'p', model: 'main-model' },
    cheap: { providerId: 'p', model: 'cheap-model' },
  },
  embedding: { providerId: 'p', model: 'embed-model' },
};

/**
 * 写一份 config.json 再重新加载模块。
 *
 * 配置有模块级缓存，跨用例必须换一份新模块，否则读到的是上一个用例的配置。
 */
async function loadConfig(file: unknown): Promise<ConfigModule> {
  if (file !== null) {
    writeFileSync(join(state.userData, 'config.json'), JSON.stringify(file), 'utf8');
  }
  vi.resetModules();
  return import('./index');
}

beforeEach(() => {
  state.userData = mkdtempSync(join(tmpdir(), 'openjob-config-'));
});

afterEach(() => {
  rmSync(state.userData, { recursive: true, force: true });
});

describe('旧版配置迁移', () => {
  it('主力档来源优先 outline', async () => {
    const { getConfig } = await loadConfig({
      llm: {
        roles: {
          outline: { providerId: 'p', model: 'outline-model' },
          codeAgent: { providerId: 'p', model: 'other-model' },
        },
      },
    });

    expect(getConfig().llm.tiers.main.model).toBe('outline-model');
  });

  it('outline 缺失时按旧数据里的其它角色名兜底，不硬编码任何角色', async () => {
    const { getConfig } = await loadConfig({
      llm: {
        roles: {
          codeAgent: { providerId: 'p', model: 'legacy-model', temperature: 0.2 },
          explain: { providerId: 'p', model: 'legacy-cheap' },
        },
      },
    });

    const config = getConfig();
    expect(config.llm.tiers.main.model).toBe('legacy-model');
    expect(config.llm.tiers.main.temperature).toBe(0.2);
    expect(config.llm.tiers.cheap.model).toBe('legacy-cheap');
    // 旧形态整体丢弃：不能有旧角色名残留到新的档位映射里
    expect(config.llm.roles).toEqual({ explain: 'cheap' });
  });

  it('新形态（角色 → 档位）原样保留', async () => {
    const { getConfig } = await loadConfig({ llm: { roles: { explain: 'main' } } });

    expect(getConfig().llm.roles).toEqual({ explain: 'main' });
  });
});

/**
 * 检索默认值的 v1 → v2 迁移：老 config.json 里那套岗位专属的检索策略（域名可信度、
 * 540 天过时阈值）是当初的默认值，按没动过处理让岗位包接管；用户真改过的留着。
 */
describe('检索默认值迁移', () => {
  it('磁盘上那份 v1 配置里等于旧默认值的项被清掉', async () => {
    const { getConfig } = await loadConfig({
      version: 1,
      search: {
        domainCredibility: { ...V1_SEARCH_DEFAULTS.domainCredibility },
        techDocStaleDays: V1_SEARCH_DEFAULTS.techDocStaleDays,
      },
    });

    const config = getConfig();
    expect(config.version).toBe(CONFIG_VERSION);
    expect(config.search.domainCredibility).toEqual({});
    expect(config.search.techDocStaleDays).toBe(DEFAULT_CONFIG.search.techDocStaleDays);
  });

  it('用户改过的那几条留下：按值比对，不比旧默认值就不算默认', async () => {
    const { getConfig } = await loadConfig({
      version: 1,
      search: {
        domainCredibility: { 'github.com': 2, 'csdn.net': 1, 'my.example': 4 },
        techDocStaleDays: 30,
      },
    });

    const config = getConfig();
    expect(config.search.domainCredibility).toEqual({ 'github.com': 2, 'my.example': 4 });
    expect(config.search.techDocStaleDays).toBe(30);
  });
});

describe('resolveLlmRole', () => {
  it('拿不到角色（岗位包没声明/没装）时落 main 档，不失败', async () => {
    const { resolveLlmRole } = await loadConfig({ llm: USABLE_LLM });

    expect(resolveLlmRole(undefined).tier).toBe('main');
    expect(resolveLlmRole(undefined).model).toBe('main-model');
  });

  it('岗位角色按映射走：基础包不认识这个名字也能分流', async () => {
    const { resolveLlmRole } = await loadConfig({
      llm: { ...USABLE_LLM, roles: { codeAgent: 'cheap' } },
    });

    expect(resolveLlmRole('codeAgent')).toMatchObject({ tier: 'cheap', model: 'cheap-model' });
  });
});
