import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Explanation } from '@shared/entities';
import type { ExplanationTier } from '@shared/enums';
import { RESUME_ALIGN_RULES } from '@shared/prompts/explain';
import { completeJson } from '../llm/json';
import { resolveLlmRole } from '../config';
import { getDb, schema } from '../db';
import { getCampaignRow, getResumeRow, rowToNode } from '../campaign/repository';

function buildResumeContext(campaignId: string): string {
  const campaign = getCampaignRow(campaignId);
  if (!campaign.resumeId) {
    return (
      '（尚未关联简历：举例用通用场景，并在实例段落提醒候选人结合自身项目替换；' +
      '不要编造具体公司名/项目名当作候选人经历）'
    );
  }

  const resume = getResumeRow(campaign.resumeId);
  const parts = [`## 候选人简历原文\n${resume.rawText.slice(0, 8000)}`];
  if (resume.parsed) {
    parts.push(`## 简历结构化摘要\n${JSON.stringify(resume.parsed, null, 2).slice(0, 4000)}`);
  }
  parts.push(RESUME_ALIGN_RULES);
  return parts.join('\n\n');
}

function rowToExplanation(row: typeof schema.explanation.$inferSelect): Explanation {
  return {
    id: row.id,
    nodeId: row.nodeId,
    tier: row.tier,
    contentMd: row.contentMd,
    modelUsed: row.modelUsed,
    sourceIds: row.sourceIds,
    createdAt: row.createdAt,
  };
}

export function getExplanation(nodeId: string, tier: ExplanationTier): Explanation | null {
  const row = getDb()
    .select()
    .from(schema.explanation)
    .where(and(eq(schema.explanation.nodeId, nodeId), eq(schema.explanation.tier, tier)))
    .get();

  if (!row) return null;
  return rowToExplanation(row);
}

export async function generateExplanation(
  nodeId: string,
  tier: ExplanationTier,
  instruction?: string,
): Promise<Explanation> {
  const db = getDb();
  const nodeRow = db
    .select()
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.id, nodeId))
    .get();
  if (!nodeRow) throw new Error('考点不存在');

  const node = rowToNode(nodeRow);
  const campaign = getCampaignRow(node.campaignId);
  const { model } = resolveLlmRole('explain');
  const resumeContext = buildResumeContext(node.campaignId);

  const content = await completeJson<{ markdown: string }>(
    'explain',
    'explain.generate',
    `公司：${campaign.company}
岗位：${campaign.roleTitle}
考点：${node.name}
覆盖类型：${node.coverageType}
考察形式：${node.examForms.join(', ')}

${resumeContext}`,
    undefined,
    { tier, instruction },
  );

  const now = Date.now();
  const existing = getExplanation(nodeId, tier);

  if (existing) {
    db.update(schema.explanation)
      .set({ contentMd: content.markdown, modelUsed: model, createdAt: now })
      .where(eq(schema.explanation.id, existing.id))
      .run();
    return { ...existing, contentMd: content.markdown, modelUsed: model, createdAt: now };
  }

  const id = randomUUID();
  db.insert(schema.explanation)
    .values({
      id,
      nodeId,
      tier,
      contentMd: content.markdown,
      modelUsed: model,
      sourceIds: [],
      createdAt: now,
    })
    .run();

  return {
    id,
    nodeId,
    tier,
    contentMd: content.markdown,
    modelUsed: model,
    sourceIds: [],
    createdAt: now,
  };
}

/** 兜底话术：30 秒能说完，不求深度 */
export async function generateFallbackScript(
  nodeId: string,
  instruction?: string,
): Promise<Explanation> {
  const db = getDb();
  const nodeRow = db
    .select()
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.id, nodeId))
    .get();
  if (!nodeRow) throw new Error('考点不存在');

  const node = rowToNode(nodeRow);
  const campaign = getCampaignRow(node.campaignId);
  const { model } = resolveLlmRole('explain');
  const resumeContext = buildResumeContext(node.campaignId);

  const content = await completeJson<{ markdown: string }>(
    'explain',
    'explain.fallback',
    `公司：${campaign.company} 岗位：${campaign.roleTitle} 考点：${node.name}

${resumeContext}`,
    undefined,
    instruction ? { instruction } : undefined,
  );

  const now = Date.now();
  const id = randomUUID();
  db.insert(schema.explanation)
    .values({
      id,
      nodeId,
      tier: 'oneliner',
      contentMd: content.markdown,
      modelUsed: model,
      sourceIds: [],
      createdAt: now,
    })
    .run();

  return {
    id,
    nodeId,
    tier: 'oneliner',
    contentMd: content.markdown,
    modelUsed: model,
    sourceIds: [],
    createdAt: now,
  };
}

/** 用户手动修订讲解内容 */
export function updateExplanation(id: string, contentMd: string): Explanation {
  const trimmed = contentMd.trim();
  if (!trimmed) throw new Error('讲解内容不能为空');

  const db = getDb();
  const row = db.select().from(schema.explanation).where(eq(schema.explanation.id, id)).get();
  if (!row) throw new Error('讲解不存在');

  const now = Date.now();
  db.update(schema.explanation)
    .set({ contentMd: trimmed, modelUsed: 'user-edit', createdAt: now })
    .where(eq(schema.explanation.id, id))
    .run();

  return rowToExplanation({ ...row, contentMd: trimmed, modelUsed: 'user-edit', createdAt: now });
}

/** 对讲解中选中的词句做进一步口语化解释 */
export async function elaborateExplanationSelection(
  nodeId: string,
  tier: ExplanationTier,
  selectedText: string,
  contextMd?: string,
): Promise<{ selectedText: string; elaborationMd: string }> {
  const text = selectedText.trim();
  if (!text) throw new Error('请先选择要细化的词句');

  const db = getDb();
  const nodeRow = db
    .select()
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.id, nodeId))
    .get();
  if (!nodeRow) throw new Error('考点不存在');

  const node = rowToNode(nodeRow);
  const campaign = getCampaignRow(node.campaignId);
  const resumeContext = buildResumeContext(node.campaignId);

  const content = await completeJson<{ markdown: string }>(
    'explain',
    'explain.elaborate',
    `公司：${campaign.company}
岗位：${campaign.roleTitle}
考点：${node.name}
讲解档位：${tier}

${resumeContext}

## 当前讲解全文（节选）
${(contextMd ?? '').slice(0, 6000)}

## 用户划选内容
${text}`,
  );

  return { selectedText: text, elaborationMd: content.markdown };
}

/** 重写讲解中选中的一段，替换进全文 */
export async function rewriteExplanationSelection(
  nodeId: string,
  tier: ExplanationTier,
  selectedText: string,
  contextMd?: string,
): Promise<{ selectedText: string; rewrittenMd: string }> {
  const text = selectedText.trim();
  if (!text) throw new Error('请先选择要重新生成的段落');

  const db = getDb();
  const nodeRow = db
    .select()
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.id, nodeId))
    .get();
  if (!nodeRow) throw new Error('考点不存在');

  const node = rowToNode(nodeRow);
  const campaign = getCampaignRow(node.campaignId);
  const resumeContext = buildResumeContext(node.campaignId);

const content = await completeJson<{ markdown: string }>(
    'explain',
    'explain.rewrite',
    `公司：${campaign.company}
岗位：${campaign.roleTitle}
考点：${node.name}
讲解档位：${tier}

${resumeContext}

## 当前讲解全文（节选）
${(contextMd ?? '').slice(0, 6000)}

## 待重写段落
${text}`,
  );

  return { selectedText: text, rewrittenMd: content.markdown };
}

export function replaceExplanationExcerpt(
  contentMd: string,
  selectedText: string,
  replacement: string,
): string {
  const sel = selectedText.trim();
  const rep = replacement.trim();
  if (!sel || !rep) throw new Error('替换内容为空');
  if (contentMd.includes(sel)) {
    return contentMd.replace(sel, rep);
  }
  const collapsed = (s: string) => s.replace(/\s+/g, ' ').trim();
  if (collapsed(contentMd).includes(collapsed(sel))) {
    throw new Error('选区与原文格式不完全一致，请重新划选后再试');
  }
  throw new Error('无法在讲解正文中定位选区，请重新划选');
}
