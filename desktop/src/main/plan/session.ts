import { desc, eq } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { appendMessage, createSession } from '../session';

/**
 * 排期决策记录。
 *
 * 优先级公式可见可调还不够——用户还得知道「这一版计划为什么长这样」：
 * 谁排在前面、谁被前置约束往后推、谁排不下退化成兜底话术。
 * 这些用 planning 类型的会话存下来，和问答、刷题一样可回看。
 */

/**
 * 一场面试只保留一条排期会话，重新排期是往里追加而不是新开——
 * 这样「这个计划怎么演化成现在这样」是一条连续的线。
 */
function planningSessionId(campaignId: string, titleIfNew: string): string {
  const existing = getDb()
    .select()
    .from(schema.session)
    .where(eq(schema.session.campaignId, campaignId))
    .orderBy(desc(schema.session.createdAt))
    .all()
    .find((s) => s.kind === 'planning');

  return existing?.id ?? createSession('planning', titleIfNew, campaignId);
}

export interface PlanDecisionInput {
  campaignId: string;
  interviewDate: string;
  dailyMinutes: number;
  budgetMinutes: number;
  daysCreated: number;
  tasksCreated: number;
  overflowFallbacks: number;
  /** 按最终排期顺序的前几个考点 */
  topNodes: Array<{ name: string; score: number; coverageType: string }>;
  /** 因前置约束被提前的考点名 */
  reorderedByPrerequisite: string[];
}

// 这些消息直接以纯文本展示，不走 markdown 渲染，所以不要用 # 和 * 之类的标记
function stamp(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

/** 生成计划时写一条决策记录 */
export function recordPlanDecision(input: PlanDecisionInput): string {
  const lines: string[] = [
    `${stamp()} 重新排期`,
    '',
    `面试日 ${input.interviewDate}，共排 ${input.daysCreated} 天、${input.tasksCreated} 个任务`,
    `每日可用 ${input.dailyMinutes} 分钟，只排 ${input.budgetMinutes} 分钟，余下的留作缓冲`,
  ];

  if (input.overflowFallbacks > 0) {
    lines.push(`${input.overflowFallbacks} 个考点时间上排不下，退化为兜底话术放在最后一天`);
  }

  if (input.reorderedByPrerequisite.length > 0) {
    lines.push(`前置约束改变了顺序：${input.reorderedByPrerequisite.slice(0, 8).join('、')}`);
  }

  if (input.topNodes.length > 0) {
    lines.push('', '排在最前面的考点：');
    for (const [i, n] of input.topNodes.entries()) {
      lines.push(`${i + 1}. ${n.name}（${n.coverageType}，优先级 ${n.score.toFixed(2)}）`);
    }
  }

  const sessionId = planningSessionId(input.campaignId, '排期决策记录');
  appendMessage(sessionId, 'assistant', lines.join('\n'));
  return sessionId;
}

/** 计划被手动改动时追加一条，形成变更史 */
export function recordPlanChange(campaignId: string, summary: string): void {
  const sessionId = planningSessionId(campaignId, '排期决策记录');
  appendMessage(sessionId, 'assistant', `${stamp()} ${summary}`);
}
