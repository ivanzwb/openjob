import type { SourcePolicy } from '@core/plugins/types';

export const sourcePolicy: SourcePolicy = {
  preferredDomains: [
    'woshipm.com',
    'pmcaff.com',
    'lenny.substack.com',
    'svpg.com',
    'mindtheproduct.com',
    'nowcoder.com',
    'zhihu.com',
    '1point3acres.com',
  ],
  credibilityOverrides: {
    'svpg.com': 5,
    'lenny.substack.com': 4,
    'mindtheproduct.com': 4,
    'woshipm.com': 3,
    'pmcaff.com': 3,
    'nowcoder.com': 3,
    'zhihu.com': 3,
    '1point3acres.com': 3,
  },
  freshnessDays: {
    companyIntel: 7,
    interviewReports: 3,
    // 产品方法论的变化比技术栈慢，放宽到两年仍然可用
    domainKnowledge: 730,
  },
};
