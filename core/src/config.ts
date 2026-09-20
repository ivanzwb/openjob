/**
 * 应用配置。持久化到 <userData>/config.json。
 *
 * 安全约定：配置里只存 `apiKeyRef`（密钥在 safeStorage 中的条目名），
 * 绝不存明文 API Key。密钥经 Electron safeStorage 加密后单独落盘。
 */

import type { CoverageType, LlmTier, SearchProviderName } from './enums';

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
 *
 * 键是角色名：基础角色见 BASE_LLM_ROLES，岗位特有角色由岗位包在能力声明里声明
 * （见 core/src/llm/roles.ts）。未列出的角色一律落 main，所以这里不承担白名单
 * 职责——有效键集由主进程按「基础角色 + 已装包声明」收敛。
 */
export interface LlmConfig {
  providers: LlmProviderConfig[];
  tiers: Record<LlmTier, LlmTierConfig>;
  /** 角色 → 档位映射；未列出的角色落到 main */
  roles: Partial<Record<string, LlmTier>>;
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
 * 自动更新。默认查官方 GitHub Release，自己分发的可以指到自己的目录。
 * 不想让它联网就关掉 checkOnStartup，此后只有手动点检查才发请求。
 */
export interface UpdateConfig {
  /** electron-builder generic provider 的目录 URL（里面应有 latest.yml）；留空走官方 GitHub Release */
  feedUrl: string;
  checkOnStartup: boolean;
}

/** 界面主题。light 为默认（白底方案），dark 为深色方案。 */
export type UiTheme = 'dark' | 'light';

export interface UiConfig {
  theme: UiTheme;
}

export interface AppConfig {
  /** 配置结构版本，用于后续迁移 */
  version: number;
  llm: LlmConfig;
  search: SearchConfig;
  priority: PriorityWeights;
  update: UpdateConfig;
  ui: UiConfig;
}

/**
 * 配置结构版本。
 *
 * v2：检索质量与路由里岗位专属的那部分（域名可信度表、领域知识过时阈值）移出基础包，
 * 改由岗位包的 `sourcePolicy` 提供（插入点 C）。见 dropLegacySearchDefaults。
 */
export const CONFIG_VERSION = 2;

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
    /**
     * 基础包对域名可信度**没有意见**：github.com / nowcoder.com / csdn.net 这一类的
     * 权重是岗位自己的判断（软件工程岗位看重面经站与代码站，产品、销售岗位看重的完全
     * 是另一批），所以由岗位包的 sourcePolicy 提供（插入点 C），这里留空。
     * 没有岗位包时未知域名一律按中性分处理，用户也可以自己加。
     */
    domainCredibility: {},
    cacheTtlDays: {
      companyIntel: 7,
      interviewReports: 3,
      techDocs: 30,
    },
    /** 通用口径：一年前的技术/领域文档算旧。岗位包按自己的领域给值（工程 540 天、销售 730 天） */
    techDocStaleDays: 365,
  },
  priority: DEFAULT_PRIORITY_WEIGHTS,
  update: {
    feedUrl: '',
    checkOnStartup: true,
  },
  ui: {
    theme: 'light',
  },
};

/**
 * v1 的基础检索默认值：那一整套其实是软件工程岗位的策略（八个域名及其可信度、540 天的
 * 领域知识过时阈值），岗位包出现后它们由包的 `sourcePolicy` 提供，基础包改成中立。
 */
export const V1_SEARCH_DEFAULTS = {
  domainCredibility: {
    'github.com': 5,
    'stackoverflow.com': 4,
    'nowcoder.com': 3,
    'juejin.cn': 3,
    'zhihu.com': 3,
    '1point3acres.com': 3,
    'cnblogs.com': 2,
    'csdn.net': 1,
  } as Record<string, number>,
  techDocStaleDays: 540,
};

/**
 * v1 → v2 的检索配置迁移：把**恰好等于旧默认值**的项当成没动过删掉。
 *
 * 为什么要删：合并顺序是「core 默认 < 岗位包 < 用户显式修改」，而判定「用户改过没有」
 * 靠按值比对。老 config.json 里这些键写着的是当年的默认值，不删就会被认成用户自己的
 * 选择，岗位包的策略反而永远盖不进去（表现就是：换了/卸了岗位包，这几个字段纹丝不动）。
 * 用户真改过的不等于旧默认值，原样保留。
 */
export function dropLegacySearchDefaults(
  search: Partial<SearchConfig> | undefined,
  version: number | undefined,
): Partial<SearchConfig> | undefined {
  if (!search) return search;
  if ((version ?? 1) >= CONFIG_VERSION) return search;

  const domainCredibility: Record<string, number> = {};
  for (const [domain, score] of Object.entries(search.domainCredibility ?? {})) {
    if (V1_SEARCH_DEFAULTS.domainCredibility[domain] !== score) domainCredibility[domain] = score;
  }

  const next: Partial<SearchConfig> = { ...search, domainCredibility };
  if (next.techDocStaleDays === V1_SEARCH_DEFAULTS.techDocStaleDays) delete next.techDocStaleDays;
  return next;
}

/** 与磁盘/同步 JSON 合并默认值（不含桌面旧版配置迁移逻辑） */
export function mergeAppConfig(loaded: Partial<AppConfig> | null | undefined): AppConfig {
  const base = structuredClone(DEFAULT_CONFIG);
  if (!loaded) return base;
  const loadedSearch = dropLegacySearchDefaults(loaded.search, loaded.version);
  return {
    version: CONFIG_VERSION,
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
        bocha: { ...base.search.providers.bocha, ...loadedSearch?.providers?.bocha },
        tavily: { ...base.search.providers.tavily, ...loadedSearch?.providers?.tavily },
      },
      routing: loadedSearch?.routing?.length ? loadedSearch.routing : base.search.routing,
      defaultProvider: loadedSearch?.defaultProvider ?? base.search.defaultProvider,
      domainCredibility: {
        ...base.search.domainCredibility,
        ...loadedSearch?.domainCredibility,
      },
      cacheTtlDays: { ...base.search.cacheTtlDays, ...loadedSearch?.cacheTtlDays },
      techDocStaleDays: loadedSearch?.techDocStaleDays ?? base.search.techDocStaleDays,
    },
    priority: {
      ...base.priority,
      ...loaded.priority,
      coverageBoost: { ...base.priority.coverageBoost, ...loaded.priority?.coverageBoost },
      targetMastery: { ...base.priority.targetMastery, ...loaded.priority?.targetMastery },
    },
    update: { ...base.update, ...loaded.update },
    // 主题的默认值只在字段缺失时生效：显式存过 'dark' 的用户不能被新默认值改掉
    ui: { theme: loaded.ui?.theme ?? base.ui.theme },
  };
}
