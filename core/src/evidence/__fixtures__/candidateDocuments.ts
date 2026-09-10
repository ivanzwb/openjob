/**
 * 证据抽取与定位用的标准输入。
 *
 * 简历和 JD 放在同一个文件里是刻意的：这个任务要挡的就是「这两段文字看起来
 * 一样，混进去没人发现」。测试要能一眼看出哪几个词只在 JD 里出现过，才能断言
 * 它们没有漏进候选人证据。
 */

import type { CandidateDocument, JobContextDocument } from '../types';

export const RESUME_ID = 'resume-zhang';
export const VARIANT_ID = 'variant-zhang-acme';
export const SELF_REPORT_ID = 'report-acme-round1';

export const RESUME_MD = [
  '## 基本信息',
  '',
  '- 姓名：张三',
  '',
  '## 工作经历',
  '',
  '### 示例网络 | 后端工程师 | 2021-04 ~ 至今',
  '',
  '- 负责网关限流与熔断，QPS 从 8000 提升到 20000',
  '- 参与订单服务拆分',
  '',
  '## 项目经历',
  '',
  '### 订单对账平台 | 技术负责人 | 2022-06 ~ 2023-03',
  '',
  '- 对账差错率从 0.3% 降到 0.01%',
  '',
  '## 专业技能',
  '',
  '- 后端：Java、Go、MySQL、Redis',
  '- 工具：Docker',
  '',
  '## 资格证书',
  '',
  '- AWS 解决方案架构师',
  '',
  '## 教育经历',
  '',
  '### 示例大学 | 计算机科学与技术 · 本科 | 2014-09 ~ 2018-06',
].join('\n');

export const SELF_REPORT_MD = [
  '- 一面被追问网关限流的令牌桶实现，说到分布式配额时卡住了',
  '- 反问环节问了团队的发布节奏',
].join('\n');

/**
 * 只在 JD 里出现、简历里一个字都没有的说法。
 *
 * 任何一条证据的 statement 或 quote 里出现它们，就意味着 JD 已经变成了「候选人
 * 做过的事」——用户会背着这段没发生过的经历进面试。
 */
export const JD_ONLY_PHRASES = ['Kubernetes', '跨机房容灾演练', '主导过'] as const;

export const JD_RAW = [
  '岗位要求：',
  '- 有 Kubernetes 集群治理经验',
  '- 主导过 跨机房容灾演练',
  '- 熟悉 Redis 缓存与持久化',
].join('\n');

export const COMPANY_INTEL_MD = ['技术栈：Kubernetes、Istio', '近期热点：多活架构'].join('\n');

export function candidateDocuments(): CandidateDocument[] {
  return [
    { kind: 'resume', id: RESUME_ID, text: RESUME_MD },
    { kind: 'selfReport', id: SELF_REPORT_ID, text: SELF_REPORT_MD },
  ];
}

export function jobContextDocuments(): JobContextDocument[] {
  return [
    { kind: 'jd', id: 'campaign-acme', text: JD_RAW },
    { kind: 'company', id: 'intel-acme', text: COMPANY_INTEL_MD },
  ];
}
