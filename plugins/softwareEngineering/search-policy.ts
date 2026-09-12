import type { SourcePolicy } from '@core/plugins/types';

export const sourcePolicy: SourcePolicy = {
  preferredDomains: [
    'github.com',
    'stackoverflow.com',
    'nowcoder.com',
    'juejin.cn',
    'zhihu.com',
    '1point3acres.com',
    'cnblogs.com',
    'csdn.net',
  ],
  credibilityOverrides: {
    'github.com': 5,
    'stackoverflow.com': 4,
    'nowcoder.com': 3,
    'juejin.cn': 3,
    'zhihu.com': 3,
    '1point3acres.com': 3,
    'cnblogs.com': 2,
    'csdn.net': 1,
  },
  freshnessDays: {
    companyIntel: 7,
    interviewReports: 3,
    domainKnowledge: 540,
  },
};
