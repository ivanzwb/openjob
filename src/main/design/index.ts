import { eq } from 'drizzle-orm';
import type { DesignCaseResult, DesignSubmitResult } from '@shared/ipc';
import { completeJson } from '../llm/json';
import { getCampaignRow } from '../campaign/repository';
import { getDb, schema } from '../db';
import { saveSpeechFromDesign } from '../speech';
import {
  DESIGN_CASE_SYSTEM,
  DESIGN_SCORE_SYSTEM,
  type DesignCaseGenerated,
  type DesignScoreGenerated,
} from './prompts';

export async function generateDesignCase(campaignId: string): Promise<DesignCaseResult> {
  const campaign = getCampaignRow(campaignId);
  const db = getDb();

  const nodes = db
    .select()
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.campaignId, campaignId))
    .all();

  const designNodes = nodes.filter((n) => n.examForms.includes('design'));
  const nodeHints = (designNodes.length ? designNodes : nodes.slice(0, 8))
    .map((n) => n.name)
    .join('、');

  const resume = campaign.resumeId
    ? db.select().from(schema.resume).where(eq(schema.resume.id, campaign.resumeId)).get()
    : null;

  const generated = await completeJson<DesignCaseGenerated>(
    'quiz',
    DESIGN_CASE_SYSTEM,
    `公司：${campaign.company}
岗位：${campaign.roleTitle}
JD 摘要：${campaign.jdParsed ? JSON.stringify(campaign.jdParsed.requirements?.slice(0, 8)) : campaign.jdRaw.slice(0, 1500)}
简历技能：${resume?.parsed?.skills?.join('、') ?? '（未提供）'}
相关考点：${nodeHints}`,
  );

  return {
    campaignId,
    company: campaign.company,
    roleTitle: campaign.roleTitle,
    ...generated,
  };
}

export async function submitDesignAnswer(
  campaignId: string,
  caseTitle: string,
  scenarioMd: string,
  userAnswer: string,
): Promise<DesignSubmitResult> {
  const campaign = getCampaignRow(campaignId);

  const scored = await completeJson<DesignScoreGenerated>(
    'quiz',
    DESIGN_SCORE_SYSTEM,
    `公司：${campaign.company} 岗位：${campaign.roleTitle}
题目：${caseTitle}
场景：${scenarioMd}
候选人回答：${userAnswer}`,
  );

  const score = Math.min(5, Math.max(1, Math.round(scored.score)));
  const attempt = saveSpeechFromDesign(campaignId, caseTitle, scored.improvedOutlineMd);

  return {
    score,
    feedbackMd: scored.feedbackMd,
    improvedOutlineMd: scored.improvedOutlineMd,
    speechSnippetId: attempt.id,
  };
}
