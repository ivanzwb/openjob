/**
 * 候选人上下文的取数层。
 *
 * 措辞由 @shared/prompts/candidateContext 决定（双端必须长一样），这里只负责
 * 从 drizzle 把战役与关联简历读出来。考我/追问/细化都从这里取，避免各调用点
 * 自己手拼一段「公司：… 岗位：…」——那正是简历一直没进 prompt 的原因。
 */

import { eq } from 'drizzle-orm';
import type { KnowledgeNode } from '@shared/entities';
import { buildCandidateContext, jdSummaryForPrompt } from '@shared/prompts/candidateContext';
import { resolvePrompt } from '@shared/prompts/registry';
import { getDb, schema } from '../db';
import { getCampaignRow, rowToNode } from './repository';

type NodeContext = Pick<KnowledgeNode, 'name' | 'coverageType' | 'examForms'>;

export function buildCampaignCandidateContext(
  campaignId: string,
  node?: NodeContext,
  /** 用户这一轮的输入：题目、答题内容、划选原文。与考点名一起决定挑哪几段简历经历 */
  userText?: string | null,
): string {
  const campaign = getCampaignRow(campaignId);
  const resume = campaign.resumeId
    ? getDb().select().from(schema.resume).where(eq(schema.resume.id, campaign.resumeId)).get()
    : null;

  return buildCandidateContext(
    {
      company: campaign.company,
      roleTitle: campaign.roleTitle,
      jdSummary: jdSummaryForPrompt(campaign),
      resumeSkills: resume?.parsed?.skills ?? null,
      resumeRawText: resume?.rawText ?? null,
      resumeProjects: resume?.parsed?.projects ?? null,
    },
    node
      ? { name: node.name, coverageType: node.coverageType, examForms: node.examForms }
      : undefined,
    { userText },
  );
}

/**
 * 追问的 system prompt。
 *
 * 渲染进程碰不到数据库，它传下来的那份只有考点名；简历、JD、公司只能在主进程
 * 用 nodeId 回查，所以这里重新解析一遍覆盖它。考点查不到（已被删等）时退回
 * 渲染层那份——少一段简历上下文也好过整段对话失败。
 */
export function buildNodeFollowUpSystem(nodeId: string | undefined, fallback: string): string {
  if (!nodeId) return fallback;

  try {
    const row = getDb()
      .select()
      .from(schema.knowledgeNode)
      .where(eq(schema.knowledgeNode.id, nodeId))
      .get();
    if (!row) return fallback;

    const node = rowToNode(row);
    return resolvePrompt('followUp.node', {
      nodeName: node.name,
      nodeId,
      candidateContext: buildCampaignCandidateContext(node.campaignId, node),
    }).text;
  } catch (err) {
    // 不留痕的话，「追问看不到简历」会退化成一个永远查不出来的问题
    console.error('[followUp] 构造带简历的 system prompt 失败，退回精简版', err);
    return fallback;
  }
}
