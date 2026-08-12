/**
 * 应用配置。持久化到 <userData>/config.json。
 *
 * 安全约定：配置里只存 `apiKeyRef`（密钥在 safeStorage 中的条目名），
 * 绝不存明文 API Key。密钥经 Electron safeStorage 加密后单独落盘。
 */

import type { CoverageType, LlmRole, LlmTier, SearchProviderName } from './enums';

export interface LlmProviderConfig {
  id: string;
  label: string;
  /** OpenAI 兼容端点，如 https://api.example.com/v1 */
  baseUrl: string;
  apiKeyRef: string;
}

export interface LlmTierConfig {
  providerId: string;
  model: string;
  temperature?: number;
}

/**
 * 两层结构：档位（tier）定义模型，角色（role）只做映射。
 * 默认只配 tiers.main 即可完整运行；cheap 是可选成本优化。
 * 硬约束：codeAgent 落在 main 档——agentic 循环对工具协议遵循率要求高，
 * 弱模型在这里发疯的代价远高于省下的钱。
 */
export interface LlmConfig {
  providers: LlmProviderConfig[];
  tiers: Record<LlmTier, LlmTierConfig>;
  /** 角色 → 档位映射；未列出的角色落到 main */
  roles: Partial<Record<LlmRole, LlmTier>>;
  /**
   * embedding 不参与档位选择：模型一换向量空间就变，已有图谱/真题向量全部失效。
   * 它是固定资产，作为固定配置存在，设置页只允许查看不允许随意切换。
   */
  embedding: {
    providerId: string;
    model: string;
  };
}

export interface SearchRoutingRule {
  match: {
    lang?: 'zh' | 'en';
    domainHint?: string[];
  };
  provider: SearchProviderName;
}

export interface SearchConfig {
  providers: {
    bocha: { endpoint: string; apiKeyRef: string; enabled: boolean };
    tavily: {
      apiKeyRef: string;
      enabled: boolean;
      /**
       * 地域偏好，小写英文国名如 china / united states。
       * 面经和薪资这类内容强烈地域相关，同一个查询在不同地区该给不同结果。
       * 留空表示不限，Tavily 按全球热度排。
       */
      country: string;
    };
  };
  /** 按顺序匹配，命中即用；均未命中时落到 defaultProvider */
  routing: SearchRoutingRule[];
  defaultProvider: SearchProviderName;
  /** 域名 → 可信度 0-5，0 为黑名单直接过滤 */
  domainCredibility: Record<string, number>;
  cacheTtlDays: {
    companyIntel: number;
    interviewReports: number;
    techDocs: number;
  };
  /**
   * 技术文档超过这个天数就标记为过时：结果往后排，并在进模型上下文时附带日期与警告。
   * 默认 540 天（约一年半），跨过这个量级主流框架通常已有破坏性变更。
   * 设为 0 关闭时效判定。
   */
  techDocStaleDays: number;
}

/**
 * 优先级公式的可调权重。
 *
 * 排序一旦成为黑盒，用户不认同就不会跟着计划走，Agent 形态直接垮掉。
 * 所以公式不只要可见，还必须可调。
 *
 * score = examProb^probExp × masteryGap^gapExp × coverageBoost ÷ estMinutes^costExp
 */
export interface PriorityWeights {
  /** 考察概率的指数，调大更偏向高频考点 */
  probExp: number;
  /** 掌握差距的指数，调大更偏向完全不会的点 */
  gapExp: number;
  /** 学习成本的惩罚指数，0 表示完全不看时长 */
  costExp: number;
  /** 各覆盖类型的额外倍率 */
  coverageBoost: Record<CoverageType, number>;
  /** 各覆盖类型要求达到的掌握度，决定掌握差距 */
  targetMastery: Record<CoverageType, number>;
}

/**
 * 自动更新。项目不绑定固定的发布地址，更新源由用户填。
 * feedUrl 为空即关闭自动更新，不会有任何网络请求。
 */
export interface UpdateConfig {
  /** electron-builder generic provider 的目录 URL，里面应有 latest.yml */
  feedUrl: string;
  checkOnStartup: boolean;
}

export interface AppConfig {
  /** 配置结构版本，用于后续迁移 */
  version: number;
  llm: LlmConfig;
  search: SearchConfig;
  priority: PriorityWeights;
  update: UpdateConfig;
}

export const CONFIG_VERSION = 1;

export const DEFAULT_PRIORITY_WEIGHTS: PriorityWeights = {
  probExp: 1,
  gapExp: 1,
  costExp: 1,
  coverageBoost: { deepDive: 1.2, gap: 1, landmine: 1.1, extra: 0.8 },
  targetMastery: { deepDive: 5, gap: 3, landmine: 4, extra: 2 },
};

/**
 * 首次启动时写入的默认配置。
 * 模型名留空，强制用户在 Settings 中显式选择——不猜测用户用哪家模型。
 */
export const DEFAULT_CONFIG: AppConfig = {
  version: CONFIG_VERSION,
  llm: {
    providers: [
      {
        id: 'default',
        label: 'Default (OpenAI compatible)',
        baseUrl: '',
        apiKeyRef: 'llm.default',
      },
    ],
    tiers: {
      main: { providerId: 'default', model: '' },
      cheap: { providerId: 'default', model: '' },
    },
    roles: { explain: 'cheap' },
    embedding: { providerId: 'default', model: '' },
  },
  search: {
    providers: {
      bocha: {
        endpoint: 'https://api.bochaai.com/v1/web-search',
        apiKeyRef: 'search.bocha',
        enabled: true,
      },
      tavily: { apiKeyRef: 'search.tavily', enabled: true, country: '' },
    },
    // 中文走博查，英文文档域名走 Tavily
    routing: [
      { match: { lang: 'zh' }, provider: 'bocha' },
      {
        match: { domainHint: ['github.com', 'docs.*', '*.io', '*.dev', 'stackoverflow.com'] },
        provider: 'tavily',
      },
      { match: { lang: 'en' }, provider: 'tavily' },
    ],
    defaultProvider: 'bocha',
    domainCredibility: {
      'github.com': 5,
      'stackoverflow.com': 4,
      'nowcoder.com': 3,
      'juejin.cn': 3,
      'zhihu.com': 3,
      '1point3acres.com': 3,
      'cnblogs.com': 2,
      'csdn.net': 1,
    },
    cacheTtlDays: {
      companyIntel: 7,
      interviewReports: 3,
      techDocs: 30,
    },
    techDocStaleDays: 540,
  },
  priority: DEFAULT_PRIORITY_WEIGHTS,
  update: {
    feedUrl: '',
    checkOnStartup: true,
  },
};

/** 与磁盘/同步 JSON 合并默认值（不含桌面 legacy 迁移逻辑） */
export function mergeAppConfig(loaded: Partial<AppConfig> | null | undefined): AppConfig {
  const base = structuredClone(DEFAULT_CONFIG);
  if (!loaded) return base;
  return {
    version: loaded.version ?? base.version,
    llm: {
      providers: loaded.llm?.providers?.length ? loaded.llm.providers : base.llm.providers,
      tiers: {
        main: { ...base.llm.tiers.main, ...loaded.llm?.tiers?.main },
        cheap: { ...base.llm.tiers.cheap, ...loaded.llm?.tiers?.cheap },
      },
      roles: { ...base.llm.roles, ...loaded.llm?.roles },
      embedding: { ...base.llm.embedding, ...loaded.llm?.embedding },
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
