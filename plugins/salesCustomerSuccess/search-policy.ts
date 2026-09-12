import type { SourcePolicy } from '@core/plugins/types';

/**
 * 行业中立。
 *
 * 刻意不收录任何厂商的销售博客或垂直行业媒体：那些内容会把某一个产品的话术
 * 当成通用方法，而这个包要同时服务软件、制造和服务业的销售岗位。留下的是
 * 通用销售方法与面试经验两类来源。
 */
export const sourcePolicy: SourcePolicy = {
  preferredDomains: [
    'hbr.org',
    'gartner.com',
    'mckinsey.com',
    'nowcoder.com',
    'zhihu.com',
    'linkedin.com',
    '1point3acres.com',
  ],
  credibilityOverrides: {
    'hbr.org': 5,
    'gartner.com': 4,
    'mckinsey.com': 4,
    'nowcoder.com': 3,
    'zhihu.com': 3,
    'linkedin.com': 3,
    '1point3acres.com': 3,
  },
  freshnessDays: {
    companyIntel: 7,
    interviewReports: 3,
    // 成交方法比产品形态更稳定，两年内的内容仍然可用
    domainKnowledge: 730,
  },
};
