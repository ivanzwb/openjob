/**
 * 规则触发检索。
 *
 * 设计明确要求以规则为主干、Agent 自主为辅：模型对「我需不需要搜」判断不准，
 * 典型表现是要么每次都搜，要么该搜时自信地编。这里把「必搜」和「别搜」都写死。
 */

export type SearchTrigger = 'required' | 'discouraged' | 'agentChoice';

export interface TriggerDecision {
  trigger: SearchTrigger;
  reason: string;
}

/** 公司/岗位相关——模型先验只知道「这类岗位一般考什么」 */
const COMPANY_HINTS = [
  '面经', '面试流程', '几轮', '面试题', '招聘', '岗位要求', 'hr面', '技术面', '一面', '二面', '三面',
];

/** 版本敏感——模型有知识截止日期，且面试中答错代价高 */
const VERSION_HINTS = [
  '最新', '新版本', '版本', '升级', '废弃', 'deprecated', '新特性', '发布', 'roadmap', 'changelog',
  '今年', '去年', '近期', '现在', '目前',
];

/** 稳定的基础知识——搜索只会引入噪音，模型自己更准 */
const STABLE_HINTS = [
  '三次握手', '四次挥手', '红黑树', '快速排序', '哈希表', '进程和线程', '进程与线程',
  'acid', '事务隔离级别', 'b+树', 'tcp和udp', 'tcp 和 udp', 'http和https',
  'gc 算法', '垃圾回收算法', '死锁', '大 o', '时间复杂度',
];

function hits(text: string, hints: string[]): string | null {
  const lower = text.toLowerCase();
  return hints.find((h) => lower.includes(h)) ?? null;
}

/**
 * 判定一次提问该不该联网。company 传入后，问题里提到公司名也视为必搜。
 */
export function decideSearchTrigger(query: string, company?: string | null): TriggerDecision {
  const lower = query.toLowerCase();

  if (company && company.trim() && lower.includes(company.trim().toLowerCase())) {
    return { trigger: 'required', reason: `提到公司「${company}」，先验不足以覆盖` };
  }

  const companyHit = hits(query, COMPANY_HINTS);
  if (companyHit) {
    return { trigger: 'required', reason: `命中面试信息关键词「${companyHit}」` };
  }

  const versionHit = hits(query, VERSION_HINTS);
  if (versionHit) {
    return { trigger: 'required', reason: `命中时效性关键词「${versionHit}」，模型知识可能过期` };
  }

  const stableHit = hits(query, STABLE_HINTS);
  if (stableHit) {
    return { trigger: 'discouraged', reason: `「${stableHit}」属稳定基础知识，检索会引入噪音` };
  }

  return { trigger: 'agentChoice', reason: '无明确规则命中，交给 Agent 判断' };
}

/** 把判定结果转成塞进 system prompt 的一段硬约束 */
export function triggerInstruction(decision: TriggerDecision): string | null {
  if (decision.trigger === 'required') {
    return `检索策略：本次**必须**先调用 web_search 再作答（${decision.reason}）。`;
  }
  if (decision.trigger === 'discouraged') {
    return `检索策略：本次**不要**联网（${decision.reason}），直接用你自己的知识作答。`;
  }
  return null;
}
