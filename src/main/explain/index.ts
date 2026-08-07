import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Explanation } from '@shared/entities';
import type { ExplanationTier } from '@shared/enums';
import { completeJson } from '../llm/json';
import { resolveLlmRole } from '../config';
import { getDb, schema } from '../db';
import { getCampaignRow, rowToNode } from '../campaign/repository';

const TIER_GUIDE: Record<ExplanationTier, string> = {
  oneliner: '一句话本质，30 秒内能说完，口语化',
  spoken:
    '可背诵的口语稿，约 2 分钟。必须是口语而不是书面语，有逻辑连接词，可以直接念出来。' +
    '例如用「其实是…配合着…」而不是「采用…相结合的方式」',
  deep: '深挖版本：原理、实现细节、取舍与常见陷阱，可稍书面但仍要能说出口',
};

const EXPLAIN_TEMPLATE = `按以下结构输出 markdown（不要 JSON）：

## 一句话本质
## 面试真实问法
（2-3 个面试官可能问的方式）
## 口语化答案框架
（分点，可背诵长度；spoken 档这是核心）
## 代码 / 实例
（如适用）
## 常见追问 & 陷阱
## 关联知识点`;

export function getExplanation(nodeId: string, tier: ExplanationTier): Explanation | null {
  const row = getDb()
    .select()
    .from(schema.explanation)
    .where(and(eq(schema.explanation.nodeId, nodeId), eq(schema.explanation.tier, tier)))
    .get();

  if (!row) return null;
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

export async function generateExplanation(
  nodeId: string,
  tier: ExplanationTier,
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

  const content = await completeJson<{ markdown: string }>(
    'explain',
    `你是面试口语教练。为候选人写考点讲解。
档位要求：${TIER_GUIDE[tier]}
${EXPLAIN_TEMPLATE}
输出 JSON：{ "markdown": "..." }`,
    `公司：${campaign.company}
岗位：${campaign.roleTitle}
考点：${node.name}
覆盖类型：${node.coverageType}
考察形式：${node.examForms.join(', ')}`,
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
export async function generateFallbackScript(nodeId: string): Promise<Explanation> {
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

  const content = await completeJson<{ markdown: string }>(
    'explain',
    `写一段 30 秒兜底口语稿。被问到不熟的知识点时不露怯，能说出框架和学习态度。
不要装懂，但要体面。输出 JSON：{ "markdown": "..." }`,
    `公司：${campaign.company} 岗位：${campaign.roleTitle} 考点：${node.name}`,
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
