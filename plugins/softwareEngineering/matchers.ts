import type { RoleMatcher } from '@core/plugins/types';

export const softwareEngineeringMatchers: RoleMatcher[] = [
  {
    titlePatterns: [
      '\\bsoftware\\s+(?:development\\s+)?engineer\\b',
      '\\bsoftware\\s+developer\\b',
      '\\b(?:backend|back-end|frontend|front-end|fullstack|full-stack)\\s+(?:developer|engineer)\\b',
      '\\b(?:mobile|ios|android|web|platform|infrastructure|devops|site reliability|sre)\\s+engineer\\b',
      '\\b(?:java|python|go|golang|javascript|typescript|c\\+\\+|rust)\\s+(?:developer|engineer)\\b',
      '(?:软件|开发|后端|前端|全栈|客户端|移动端|基础架构|平台|运维开发|测试开发|测试)工程师',
      '(?:程序员|软件开发|后端开发|前端开发|全栈开发)',
    ],
    responsibilitySignals: [
      'software development',
      'data structures',
      'algorithms',
      'distributed systems',
      'system design',
      '代码',
      '算法',
      '系统设计',
      '分布式',
    ],
    excludeSignals: [
      'product roadmap',
      'sales pipeline',
      'customer success',
      '产品路线图',
      '销售漏斗',
      '客户成功',
    ],
  },
];
