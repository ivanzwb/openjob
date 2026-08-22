import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { Explanation } from '@shared/entities';
import type { ExplanationTier } from '@shared/enums';
import { normalizeDisplayText } from '@shared/lib/markdownDisplay';
import { completeJson } from '../llm/json';
import { resolveLlmRole } from '../llm/resolve';
import { buildResumeContext, getCampaign, getKnowledgeNode } from './campaignLocal';
import { getDeviceIdentity } from '../sync/identity';
import { writingAs } from '../sync/triggers';
import { getExplanation } from './study';

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
    'explain.fallback',
    `公司：${campaign.company} 岗位：${campaign.roleTitle} 考点：${node.name}

${resumeContext}`,
    undefined,
    instruction ? { instruction } : undefined,
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

  return { selectedText: text, elaborationMd: normalizeDisplayText(content.markdown) };
}
