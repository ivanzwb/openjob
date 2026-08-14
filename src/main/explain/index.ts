import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Explanation } from '@shared/entities';
import type { ExplanationTier } from '@shared/enums';
import { userRequestBlock } from '@shared/explain/prompt';
import { completeJson } from '../llm/json';
import { resolveLlmRole } from '../config';
import { getDb, schema } from '../db';
import { getCampaignRow, getResumeRow, rowToNode } from '../campaign/repository';

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
（如适用；**必须优先用候选人简历里的项目、技术栈、职责来举例**）
## 常见追问 & 陷阱
## 关联知识点`;

const RESUME_ALIGN_RULES = `
## 简历对齐要求（非常重要）
- 面试问法、举例、项目经历、技术名词必须尽量与候选人简历一致，让候选人能直接用自己的经历口述。
- 优先引用简历中的公司、项目名、技术栈、职责描述；不要编造候选人没做过的项目。
- 若简历与考点关联弱，用通用框架回答，并明确标注「可换成你简历里的 XXX 项目/经历」。
- 问答示例里的背景、数据、角色要与简历角色匹配（如后端岗不要举纯前端项目为主例）。`;

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
    `你是面试口语教练。为候选人写考点讲解。
档位要求：${TIER_GUIDE[tier]}
${EXPLAIN_TEMPLATE}
${RESUME_ALIGN_RULES}
${userRequestBlock(instruction)}
输出 JSON：{ "markdown": "..." }`,
    `公司：${campaign.company}
岗位：${campaign.roleTitle}
考点：${node.name}
覆盖类型：${node.coverageType}
考察形式：${node.examForms.join(', ')}

${resumeContext}`,
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
    `写一段 30 秒兜底口语稿。被问到不熟的知识点时不露怯，能说出框架和学习态度。
不要装懂，但要体面。若简历有相关邻近经历可轻量提及。
${userRequestBlock(instruction)}
输出 JSON：{ "markdown": "..." }`,
    `公司：${campaign.company} 岗位：${campaign.roleTitle} 考点：${node.name}

${resumeContext}`,
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
    `你是面试口语教练。候选人正在学习考点讲解，划选了其中一段文字需要进一步解释。
要求：
- 只解释被选中的词句/概念/名称，结合当前考点与讲解上下文
- 口语化、1 分钟内能说完；可举小例子
- 若与简历相关，举例尽量贴合候选人简历
输出 JSON：{ "markdown": "..." }`,
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
    `你是面试口语教练。候选人划选了讲解中的一段文字，需要你重写这一段。
要求：
- 只输出替换后的这一段正文，不要标题、不要 JSON 外壳
- 保持与前后文语气一致，口语化、适合面试口述
- 举例与简历对齐；无相关经历时用通用表述并提示可替换
- 长度与原文相当，不要无故扩写太多
输出 JSON：{ "markdown": "..." }`,
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
