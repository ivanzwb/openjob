/**
 * 应用配置。持久化到 <userData>/config.json。
 *
 * 安全约定：配置里只存 `apiKeyRef`（密钥在 safeStorage 中的条目名），
 * 绝不存明文 API Key。密钥经 Electron safeStorage 加密后单独落盘。
 */

import type { CoverageType, LlmRole, SearchProviderName } from './enums';

export interface LlmProviderConfig {
  id: string;
  label: string;
  /** OpenAI 兼容端点，如 https://api.example.com/v1 */
  baseUrl: string;
  apiKeyRef: string;
}

export interface LlmRoleConfig {
  providerId: string;
  model: string;
  temperature?: number;
}

/**
 * 按任务角色配置模型而非全局单一模型，这是控成本的关键。
 * 硬约束：codeAgent 的模型必须支持 function calling，agentic 检索完全依赖它。
 */
export interface LlmConfig {
  providers: LlmProviderConfig[];
  roles: Record<LlmRole, LlmRoleConfig>;
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
    tavily: { apiKeyRef: string; enabled: boolean };
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

export interface AppConfig {
  /** 配置结构版本，用于后续迁移 */
  version: number;
  llm: LlmConfig;
  search: SearchConfig;
  priority: PriorityWeights;
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
    roles: {
      outline: { providerId: 'default', model: '' },
      explain: { providerId: 'default', model: '' },
      codeAgent: { providerId: 'default', model: '' },
      quiz: { providerId: 'default', model: '' },
      embedding: { providerId: 'default', model: '' },
    },
  },
  search: {
    providers: {
      bocha: {
        endpoint: 'https://api.bochaai.com/v1/web-search',
        apiKeyRef: 'search.bocha',
        enabled: true,
      },
      tavily: { apiKeyRef: 'search.tavily', enabled: true },
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
  },
  priority: DEFAULT_PRIORITY_WEIGHTS,
};
