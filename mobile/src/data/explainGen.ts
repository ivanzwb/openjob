import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { Explanation } from '@shared/entities';
import type { ExplanationTier } from '@shared/enums';
import { userRequestBlock } from '@shared/explain/prompt';
import { completeJson } from '../llm/json';
import { resolveLlmRole } from '../llm/resolve';
import { buildResumeContext, getCampaign, getKnowledgeNode } from './campaignLocal';
import { getDeviceIdentity } from '../sync/identity';
import { writingAs } from '../sync/triggers';
import { getExplanation } from './study';

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

export async function generateExplanation(
  db: SQLiteDatabase,
  nodeId: string,
  tier: ExplanationTier,
  instruction?: string,
): Promise<Explanation> {
  const node = getKnowledgeNode(db, nodeId);
  const campaign = getCampaign(db, node.campaignId);
  const { model } = await resolveLlmRole('explain');
  const resumeContext = buildResumeContext(db, node.campaignId);

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
  const existing = getExplanation(db, nodeId, tier);
  const identity = await getDeviceIdentity(db);

  if (existing) {
    writingAs(db, identity.deviceId, () => {
      db.runSync(
        `UPDATE explanation SET content_md = ?, model_used = ?, created_at = ? WHERE id = ?`,
        content.markdown,
        model,
        now,
        existing.id,
      );
    });
    return { ...existing, contentMd: content.markdown, modelUsed: model, createdAt: now };
  }

  const id = Crypto.randomUUID();
  writingAs(db, identity.deviceId, () => {
    db.runSync(
      `INSERT INTO explanation (id, node_id, tier, content_md, model_used, source_ids, created_at)
       VALUES (?, ?, ?, ?, ?, '[]', ?)`,
      id,
      nodeId,
      tier,
      content.markdown,
      model,
      now,
    );
  });

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

export async function generateFallbackScript(
  db: SQLiteDatabase,
  nodeId: string,
  instruction?: string,
): Promise<Explanation> {
  const node = getKnowledgeNode(db, nodeId);
  const campaign = getCampaign(db, node.campaignId);
  const { model } = await resolveLlmRole('explain');
  const resumeContext = buildResumeContext(db, node.campaignId);

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
  const id = Crypto.randomUUID();
  const identity = await getDeviceIdentity(db);
  writingAs(db, identity.deviceId, () => {
    db.runSync(
      `INSERT INTO explanation (id, node_id, tier, content_md, model_used, source_ids, created_at)
       VALUES (?, ?, 'oneliner', ?, ?, '[]', ?)`,
      id,
      nodeId,
      content.markdown,
      model,
      now,
    );
  });

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

export async function elaborateExplanationSelection(
  db: SQLiteDatabase,
  nodeId: string,
  tier: ExplanationTier,
  selectedText: string,
  contextMd?: string,
): Promise<{ selectedText: string; elaborationMd: string }> {
  const text = selectedText.trim();
  if (!text) throw new Error('请先选择要细化的词句');

  const node = getKnowledgeNode(db, nodeId);
  const campaign = getCampaign(db, node.campaignId);
  const resumeContext = buildResumeContext(db, node.campaignId);

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
