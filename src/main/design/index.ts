import { and, eq } from 'drizzle-orm';
import type { DesignCaseResult, DesignSubmitResult } from '@shared/ipc';
import type { ExamForm } from '@shared/enums';
import { completeJson } from '../llm/json';
import { getCampaignRow } from '../campaign/repository';
import { getDb, schema } from '../db';
import { saveSpeechFromDesign } from '../speech';
import {
  caseSystemForType,
  caseUserHintForType,
  scoreSystemForType,
  type DesignCaseGenerated,
  type DesignScoreGenerated,
  type MockInterviewType,
} from './prompts';

function buildInterviewContext(campaignId: string): string {
  const campaign = getCampaignRow(campaignId);
  const db = getDb();

  const nodes = db
    .select()
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.campaignId, campaignId))
    .all();

  const byForm = (form: ExamForm): string[] =>
    nodes.filter((n) => n.examForms.includes(form)).map((n) => n.name);

  const intel = db
    .select()
    .from(schema.companyIntel)
    .where(eq(schema.companyIntel.campaignId, campaignId))
    .get();

  const resume = campaign.resumeId
    ? db.select().from(schema.resume).where(eq(schema.resume.id, campaign.resumeId)).get()
    : null;

  const blindSpots = db
    .select({ questionText: schema.interviewQuestion.questionText })
    .from(schema.interviewQuestion)
    .innerJoin(
      schema.interviewReport,
      eq(schema.interviewQuestion.reportId, schema.interviewReport.id),
    )
    .where(
      and(
        eq(schema.interviewQuestion.isBlindSpot, true),
        eq(schema.interviewReport.campaignId, campaignId),
      ),
    )
    .all()
    .slice(0, 5);

  const reportSamples = db
    .select({ questionText: schema.interviewQuestion.questionText })
    .from(schema.interviewQuestion)
    .innerJoin(
      schema.interviewReport,
      eq(schema.interviewQuestion.reportId, schema.interviewReport.id),
    )
    .where(eq(schema.interviewReport.campaignId, campaignId))
    .all()
    .slice(0, 5);

  const jdSummary = campaign.jdParsed
    ? `职级：${campaign.jdParsed.seniority ?? '未知'}；要求：${campaign.jdParsed.requirements
        ?.slice(0, 10)
        .map((r) => `${r.skill}(${(r.weight * 100).toFixed(0)}%)`)
        .join('、')}`
    : campaign.jdRaw.slice(0, 1500);

  const projectSummary =
    resume?.parsed?.projects
      ?.slice(0, 4)
      .map((p) => `${p.name}：${p.summary}；可深挖：${p.drillableTopics.slice(0, 4).join('、')}`)
      .join('\n') ?? '（未提供）';

  return `公司：${campaign.company}
岗位：${campaign.roleTitle}
JD 摘要：${jdSummary}
简历技能：${resume?.parsed?.skills?.join('、') ?? '（未提供）'}
简历项目：
${projectSummary}
公司技术栈：${intel?.techStackMd?.slice(0, 600) ?? '（未调研，可结合 JD 推断）'}
面试流程：${intel?.interviewProcessMd?.slice(0, 400) ?? '（未调研）'}
公司热点：${intel?.hotTopicsMd?.slice(0, 400) ?? '（未调研）'}
概念类考点：${byForm('concept').slice(0, 10).join('、') || '无'}
编码类考点：${byForm('coding').slice(0, 10).join('、') || '无'}
系统设计考点：${byForm('design').slice(0, 8).join('、') || '无'}
项目场景考点：${byForm('scenario').slice(0, 8).join('、') || '无'}
面经真题参考：${reportSamples.map((q) => q.questionText).join('；') || '无'}
盲区提醒：${blindSpots.map((q) => q.questionText).join('；') || '无'}`;
}

export async function generateDesignCase(
  campaignId: string,
  interviewType: MockInterviewType = 'mixed',
): Promise<DesignCaseResult> {
  const campaign = getCampaignRow(campaignId);
  const context = buildInterviewContext(campaignId);

  const generated = await completeJson<DesignCaseGenerated>(
    'quiz',
    caseSystemForType(interviewType),
    `${context}\n\n${caseUserHintForType(interviewType)}`,
  );

  return {
    campaignId,
    company: campaign.company,
    roleTitle: campaign.roleTitle,
    interviewType: generated.interviewType,
    relatedNodeName: generated.relatedNodeName ?? null,
    title: generated.title,
    scenarioMd: generated.scenarioMd,
    constraints: generated.constraints ?? [],
    evaluationCriteria: generated.evaluationCriteria ?? [],
  };
}

export async function submitDesignAnswer(
  campaignId: string,
  caseTitle: string,
  scenarioMd: string,
  userAnswer: string,
  interviewType: ExamForm = 'design',
): Promise<DesignSubmitResult> {
  const context = buildInterviewContext(campaignId);

  const scored = await completeJson<DesignScoreGenerated>(
    'quiz',
    scoreSystemForType(interviewType),
    `${context}

题目类型：${interviewType}
题目：${caseTitle}
题干：${scenarioMd}
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
