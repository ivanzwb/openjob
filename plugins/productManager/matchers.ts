import type { RoleMatcher } from '@core/plugins/types';

export const productManagerMatchers: RoleMatcher[] = [
  {
    titlePatterns: [
      // 不枚举 senior/staff 之类前缀：前缀不参与匹配，反而容易漏掉没列到的写法
      '\\bproduct\\s+manager\\b',
      '\\bproduct\\s+owner\\b',
      '\\bproduct\\s+lead\\b',
      '\\bhead\\s+of\\s+product\\b',
      '(?:产品|商业产品|策略产品|数据产品|增长产品|国际化产品)经理',
      '(?:产品负责人|产品总监|产品策划|产品运营经理)',
    ],
    responsibilitySignals: [
      'product roadmap',
      'user research',
      'prioritization',
      'product requirements',
      'go-to-market',
      '产品路线图',
      '需求优先级',
      '用户调研',
      '产品规划',
      '数据指标',
    ],
    excludeSignals: [
      'data structures',
      'algorithms',
      'distributed systems',
      'code review',
      'sales pipeline',
      'customer success',
      '算法',
      '分布式',
      '代码评审',
      '销售漏斗',
    ],
  },
];
