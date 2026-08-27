import { and, eq } from 'drizzle-orm';
import type {
  DesignCaseResult,
  DesignElaborateResult,
  DesignGenerateAnswerResult,
  DesignSubmitResult,
  MockInterviewType,
} from '@shared/ipc';
import type { ExamForm } from '@shared/enums';
import type { InferSelectModel } from 'drizzle-orm';
import { completeJson } from '../llm/json';
import { getCampaignRow } from '../campaign/repository';
import {
  buildCampaignCandidateContext,
  jdSummaryForCampaign,
} from '../campaign/candidateContext';
import { getDb, schema } from '../db';
import { saveSpeechFromDesign } from '../speech';
import {
  answerUserHintForType,
  caseUserHintForType,
  designCaseCacheId,
  effectiveInterviewLanguage,
  type DesignAnswerGenerated,
  type DesignCaseGenerated,
  type DesignScoreGenerated,
  type MockInterviewKind,
  type MockInterviewLanguage,
} from '@shared/design/prompts';
import { normalizeDisplayText } from '@shared/lib/markdownDisplay';
import { resumeExperienceBlock, resumeFactsBlockForSelfIntro } from '@shared/resume/experienceTimeline';

type DesignCaseRow = InferSelectModel<typeof schema.designCase>;

function rowToDesignCaseResult(
  row: DesignCaseRow,
  campaign: ReturnType<typeof getCampaignRow>,
  interviewLanguage: MockInterviewLanguage,
): DesignCaseResult {
  return {
    campaignId: row.campaignId,
    company: campaign.company,
    roleTitle: campaign.roleTitle,
    interviewType: row.interviewType,
    interviewLanguage,
    relatedNodeName: row.relatedNodeName ?? null,
    title: row.title,
    scenarioMd: row.scenarioMd,
    constraints: row.constraints ?? [],
    evaluationCriteria: row.evaluationCriteria ?? [],
    userAnswerMd: row.userAnswerMd ?? null,
    recommendedAnswerMd: row.recommendedAnswerMd ?? null,
  };
}

function getCampaignResume(campaignId: string): {
  rawText: string;
  projects: NonNullable<InferSelectModel<typeof schema.resume>['parsed']>['projects'] | undefined;
} | null {
  const campaign = getCampaignRow(campaignId);
  if (!campaign.resumeId) return null;
  const resume = getDb()
    .select()
    .from(schema.resume)
    .where(eq(schema.resume.id, campaign.resumeId))
    .get();
  if (!resume) return null;
  return { rawText: resume.rawText ?? '', projects: resume.parsed?.projects };
}

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

  const jdSummary = jdSummaryForCampaign(campaign);

  return `公司：${campaign.company}
岗位：${campaign.roleTitle}
JD 摘要：${jdSummary}
简历技能：${resume?.parsed?.skills?.join('、') ?? '（未提供）'}
${resumeExperienceBlock(resume?.rawText ?? '', resume?.parsed?.projects)}
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
  interviewLanguage: MockInterviewLanguage = 'zh',
  force = false,
): Promise<DesignCaseResult> {
  const campaign = getCampaignRow(campaignId);
  const db = getDb();
  const effectiveLang = effectiveInterviewLanguage(interviewType, interviewLanguage);
  const cacheId = designCaseCacheId(campaignId, interviewType, interviewLanguage);
  const cached = db.select().from(schema.designCase).where(eq(schema.designCase.id, cacheId)).get();

  if (cached && !force) {
    return rowToDesignCaseResult(cached, campaign, effectiveLang);
  }

  const context = buildInterviewContext(campaignId);

  const generated = await completeJson<DesignCaseGenerated>(
    'quiz',
    'design.case',
    `${context}\n\n${caseUserHintForType(interviewType, effectiveLang)}`,
    undefined,
    { type: interviewType, language: effectiveLang },
  );

  const now = Date.now();
  db.insert(schema.designCase)
    .values({
      id: cacheId,
      campaignId,
      requestedType: interviewType,
      interviewType: generated.interviewType,
      relatedNodeName: generated.relatedNodeName ?? null,
      title: generated.title,
      scenarioMd: generated.scenarioMd,
      constraints: generated.constraints ?? [],
      evaluationCriteria: generated.evaluationCriteria ?? [],
      userAnswerMd: null,
      recommendedAnswerMd: null,
      createdAt: cached?.createdAt ?? now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.designCase.id,
      set: {
        interviewType: generated.interviewType,
        relatedNodeName: generated.relatedNodeName ?? null,
        title: generated.title,
        scenarioMd: generated.scenarioMd,
        constraints: generated.constraints ?? [],
        evaluationCriteria: generated.evaluationCriteria ?? [],
        userAnswerMd: null,
        recommendedAnswerMd: null,
        updatedAt: now,
      },
    })
    .run();

  return {
    campaignId,
    company: campaign.company,
    roleTitle: campaign.roleTitle,
    interviewType: generated.interviewType,
    interviewLanguage: effectiveLang,
    relatedNodeName: generated.relatedNodeName ?? null,
    title: generated.title,
    scenarioMd: generated.scenarioMd,
    constraints: generated.constraints ?? [],
    evaluationCriteria: generated.evaluationCriteria ?? [],
    userAnswerMd: null,
    recommendedAnswerMd: null,
  };
}

export function updateDesignCaseAnswers(
  campaignId: string,
  interviewType: MockInterviewType,
  interviewLanguage: MockInterviewLanguage,
  patch: { userAnswerMd?: string | null; recommendedAnswerMd?: string | null },
): DesignCaseResult {
  const campaign = getCampaignRow(campaignId);
  const db = getDb();
  const effectiveLang = effectiveInterviewLanguage(interviewType, interviewLanguage);
  const cacheId = designCaseCacheId(campaignId, interviewType, interviewLanguage);
  const row = db.select().from(schema.designCase).where(eq(schema.designCase.id, cacheId)).get();
  if (!row) throw new Error('请先生成题目');

  const userAnswerMd = patch.userAnswerMd !== undefined ? patch.userAnswerMd : row.userAnswerMd;
  const recommendedAnswerMd =
    patch.recommendedAnswerMd !== undefined ? patch.recommendedAnswerMd : row.recommendedAnswerMd;

  const now = Date.now();
  db.update(schema.designCase)
    .set({ userAnswerMd, recommendedAnswerMd, updatedAt: now })
    .where(eq(schema.designCase.id, cacheId))
    .run();

  return rowToDesignCaseResult({ ...row, userAnswerMd, recommendedAnswerMd }, campaign, effectiveLang);
}

export async function generateRecommendedAnswer(
  campaignId: string,
  caseTitle: string,
  scenarioMd: string,
  interviewType: MockInterviewKind,
  interviewLanguage: MockInterviewLanguage,
  constraints: string[] = [],
): Promise<DesignGenerateAnswerResult> {
  const effectiveLang = effectiveInterviewLanguage(interviewType, interviewLanguage);
  const context = buildInterviewContext(campaignId);
  const constraintHint =
    constraints.length > 0 ? `\n考察点：${constraints.join(' · ')}` : '';
  const resumeFacts =
    interviewType === 'selfIntro'
      ? (() => {
          const resume = getCampaignResume(campaignId);
          return `\n\n${resumeFactsBlockForSelfIntro(
            resume?.rawText ?? '',
            resume?.projects,
          )}`;
        })()
      : '';

  const generated = await completeJson<DesignAnswerGenerated>(
    'quiz',
    'design.answer',
    `${context}${resumeFacts}

题目类型：${interviewType}
面试语言：${effectiveLang === 'en' ? '英文' : '中文'}
题目：${caseTitle}
题干：${scenarioMd}${constraintHint}

${answerUserHintForType(interviewType, effectiveLang)}`,
    undefined,
    { type: interviewType, language: effectiveLang },
  );

  return { recommendedAnswerMd: normalizeDisplayText(generated.answerMd) };
}

export async function elaborateDesignAnswer(
  selectedText: string,
  contextMd: string,
  campaignId?: string,
): Promise<DesignElaborateResult> {
  const text = selectedText.trim();
  if (!text) throw new Error('请先选择要细化的内容');

  // 细化一段划选只需要「候选人是谁、做过什么」。buildInterviewContext 里的公司情报、
  // 考点清单、面经对这件事没用，还会和下面 6000 字的题干抢篇幅。
  const candidate = campaignId
    ? `## 候选人背景\n${buildCampaignCandidateContext(campaignId)}\n\n`
    : '';

  const content = await completeJson<{ markdown: string }>(
    'explain',
    'explain.elaborate',
    `${candidate}## 模拟面试题目与参考答案（节选）
${contextMd.slice(0, 6000)}

## 用户划选内容
${text}`,
  );

  return { elaborationMd: normalizeDisplayText(content.markdown) };
}

export async function submitDesignAnswer(
  campaignId: string,
  caseTitle: string,
  scenarioMd: string,
  userAnswer: string,
  interviewType: MockInterviewKind = 'design',
  interviewLanguage: MockInterviewLanguage = 'zh',
  requestedType: MockInterviewType = interviewType,
): Promise<DesignSubmitResult> {
  const effectiveLang = effectiveInterviewLanguage(interviewType, interviewLanguage);
  const context = buildInterviewContext(campaignId);

  const scored = await completeJson<DesignScoreGenerated>(
    'quiz',
    'design.score',
    `${context}

题目类型：${interviewType}
面试语言：${effectiveLang === 'en' ? '英文' : '中文'}
题目：${caseTitle}
题干：${scenarioMd}
候选人回答：${userAnswer}`,
    undefined,
    { type: interviewType, language: effectiveLang },
  );

  const score = Math.min(5, Math.max(1, Math.round(scored.score)));
  const attempt = saveSpeechFromDesign(campaignId, caseTitle, scored.improvedOutlineMd);
  const db = getDb();
  const cacheId = designCaseCacheId(campaignId, requestedType, interviewLanguage);
  db.update(schema.designCase)
    .set({ userAnswerMd: userAnswer, updatedAt: Date.now() })
    .where(eq(schema.designCase.id, cacheId))
    .run();

  return {
    score,
    feedbackMd: normalizeDisplayText(scored.feedbackMd),
    improvedOutlineMd: normalizeDisplayText(scored.improvedOutlineMd),
    speechSnippetId: attempt.id,
  };
}
