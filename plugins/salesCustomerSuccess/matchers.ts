import type { RoleMatcher } from '@core/plugins/types';

export const salesCustomerSuccessMatchers: RoleMatcher[] = [
  {
    titlePatterns: [
      '\\b(?:account|sales)\\s+(?:executive|manager|director)\\b',
      '\\bsales\\s+(?:development|representative)\\b',
      '\\baccount\\s+manager\\b',
      '\\bcustomer\\s+success\\s+(?:manager|engineer|specialist)\\b',
      '\\bsolution\\s+consultant\\b',
      '\\bbusiness\\s+development\\b',
      // 岗位名后缀写成必需：裸一个「销售」会把「销售系统开发工程师」也收进来，
      // 而标题命中就直接入选，JD 里的 excludeSignals 未必拦得住
      '(?:销售|大客户销售|渠道销售|解决方案销售|电话销售)(?:经理|代表|专员|总监|顾问)',
      '(?:客户成功|客户)(?:经理|专员|总监)',
      '(?:商务拓展|渠道拓展|售前顾问)',
    ],
    responsibilitySignals: [
      'quota',
      'pipeline',
      'prospecting',
      'renewal',
      'upsell',
      'customer onboarding',
      '销售目标',
      '客户拓展',
      '续约',
      '回款',
      '商务谈判',
      '客户关系维护',
    ],
    excludeSignals: [
      'data structures',
      'system design',
      'code review',
      'product roadmap',
      'user research',
      '算法',
      '分布式',
      '代码评审',
      '需求优先级',
      '产品路线图',
    ],
  },
];
