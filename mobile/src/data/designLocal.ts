import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import type {
  DesignCaseResult,
  DesignElaborateResult,
  DesignGenerateAnswerResult,
  DesignSubmitResult,
  MockInterviewType,
} from '@shared/ipc';
import type { ExamForm } from '@shared/enums';
import {
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
import {
  resumeExperienceBlock,
  type FallbackProject,
} from '@shared/resume/experienceTimeline';
import { completeJson } from '../llm/json';
import { getCampaign } from './campaignLocal';
import { getDeviceIdentity } from '../sync/identity';
import { writingAs } from '../sync/triggers';

interface DesignCaseRow {
  campaign_id: string;
  interview_type: MockInterviewKind;
  related_node_name: string | null;
  title: string;
  scenario_md: string;
  constraints: string;
  evaluation_criteria: string;
  user_answer_md: string | null;
  recommended_answer_md: string | null;
}

function parseStringList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function rowToDesignCaseResult(
  row: DesignCaseRow,
  campaign: ReturnType<typeof getCampaign>,
  interviewLanguage: MockInterviewLanguage,
): DesignCaseResult {
  return {
    campaignId: row.campaign_id,
    company: campaign.company,
    roleTitle: campaign.roleTitle,
    interviewType: row.interview_type,
    interviewLanguage,
    relatedNodeName: row.related_node_name ?? null,
    title: row.title,
    scenarioMd: row.scenario_md,
    constraints: parseStringList(row.constraints),
    evaluationCriteria: parseStringList(row.evaluation_criteria),
    userAnswerMd: row.user_answer_md ?? null,
    recommendedAnswerMd: row.recommended_answer_md ?? null,
  };
}

function buildInterviewContext(db: SQLiteDatabase, campaignId: string): string {
  const campaign = getCampaign(db, campaignId);
  const nodes = db.getAllSync<{
    name: string;
    exam_forms: string;
    coverage_type: string;
  }>(`SELECT name, exam_forms, coverage_type FROM knowledge_node WHERE campaign_id = ?`, campaignId);

  const byForm = (form: ExamForm): string[] =>
    nodes.filter((n) => {
      try {
        return (JSON.parse(n.exam_forms) as ExamForm[]).includes(form);
      } catch {
        return false;
      }
    }).map((n) => n.name);

  const intel = db.getFirstSync<{
    tech_stack_md: string;
    interview_process_md: string;
    hot_topics_md: string;
  }>(`SELECT tech_stack_md, interview_process_md, hot_topics_md FROM company_intel WHERE campaign_id = ?`, campaignId);

  const resume = campaign.resumeId
    ? db.getFirstSync<{ parsed: string | null; raw_text: string | null }>(
        `SELECT parsed, raw_text FROM resume WHERE id = ?`,
        campaign.resumeId,
      )
    : null;

  let resumeSkills = '（未提供）';
  let fallbackProjects: FallbackProject[] = [];
  if (resume?.parsed) {
    try {
      const parsed = JSON.parse(resume.parsed) as {
        projects?: FallbackProject[];
        skills?: string[];
      };
      resumeSkills = parsed.skills?.join('、') || '（未提供）';
      fallbackProjects = parsed.projects ?? [];
    } catch {
      // 解析结果坏了不该拦住出题，退回「未提供」
    }
  }

  const blindSpots = db
    .getAllSync<{ question_text: string }>(
      `SELECT q.question_text FROM interview_question q
       INNER JOIN interview_report r ON r.id = q.report_id
       WHERE r.campaign_id = ? AND q.is_blind_spot = 1 LIMIT 5`,
      campaignId,
    )
    .map((q) => q.question_text);

  const reportSamples = db
    .getAllSync<{ question_text: string }>(
      `SELECT q.question_text FROM interview_question q
       INNER JOIN interview_report r ON r.id = q.report_id
       WHERE r.campaign_id = ? LIMIT 5`,
      campaignId,
    )
    .map((q) => q.question_text);

  const jdSummary = campaign.jdParsed
    ? `职级：${campaign.jdParsed.seniority ?? '未知'}；要求：${campaign.jdParsed.requirements
        ?.slice(0, 10)
        .map((r) => `${r.skill}(${(r.weight * 100).toFixed(0)}%)`)
        .join('、')}`
    : campaign.jdRaw.slice(0, 1500);

  return `公司：${campaign.company}
岗位：${campaign.roleTitle}
JD 摘要：${jdSummary}
简历技能：${resumeSkills}
${resumeExperienceBlock(resume?.raw_text ?? '', fallbackProjects)}
公司技术栈：${intel?.tech_stack_md?.slice(0, 600) ?? '（未调研，可结合 JD 推断）'}
面试流程：${intel?.interview_process_md?.slice(0, 400) ?? '（未调研）'}
公司热点：${intel?.hot_topics_md?.slice(0, 400) ?? '（未调研）'}
概念类考点：${byForm('concept').slice(0, 10).join('、') || '无'}
编码类考点：${byForm('coding').slice(0, 10).join('、') || '无'}
系统设计考点：${byForm('design').slice(0, 8).join('、') || '无'}
项目场景考点：${byForm('scenario').slice(0, 8).join('、') || '无'}
面经真题参考：${reportSamples.join('；') || '无'}
盲区提醒：${blindSpots.join('；') || '无'}`;
}

const DESIGN_CASE_SELECT = `SELECT campaign_id, interview_type, related_node_name, title, scenario_md,
  constraints, evaluation_criteria, user_answer_md, recommended_answer_md FROM design_case WHERE id = ?`;

export async function generateDesignCase(
  db: SQLiteDatabase,
  campaignId: string,
  interviewType: MockInterviewType = 'mixed',
  interviewLanguage: MockInterviewLanguage = 'zh',
  force = false,
): Promise<DesignCaseResult> {
  const campaign = getCampaign(db, campaignId);
  const effectiveLang = effectiveInterviewLanguage(interviewType, interviewLanguage);
  const cacheId = designCaseCacheId(campaignId, interviewType, interviewLanguage);
  const cached = db.getFirstSync<DesignCaseRow>(DESIGN_CASE_SELECT, cacheId);

  if (cached && !force) {
    return rowToDesignCaseResult(cached, campaign, effectiveLang);
  }

  const context = buildInterviewContext(db, campaignId);

  const generated = await completeJson<DesignCaseGenerated>(
    'quiz',
    'design.case',
    `${context}\n\n${caseUserHintForType(interviewType, effectiveLang)}`,
    undefined,
    { type: interviewType, language: effectiveLang },
  );

  const identity = await getDeviceIdentity(db);
  const now = Date.now();
  writingAs(db, identity.deviceId, () => {
    db.runSync(
      `INSERT INTO design_case (
        id, campaign_id, requested_type, interview_type, related_node_name, title,
        scenario_md, constraints, evaluation_criteria, user_answer_md, recommended_answer_md,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        interview_type = excluded.interview_type,
        related_node_name = excluded.related_node_name,
        title = excluded.title,
        scenario_md = excluded.scenario_md,
        constraints = excluded.constraints,
        evaluation_criteria = excluded.evaluation_criteria,
        user_answer_md = NULL,
        recommended_answer_md = NULL,
        updated_at = excluded.updated_at`,
      cacheId,
      campaignId,
      interviewType,
      generated.interviewType,
      generated.relatedNodeName ?? null,
      generated.title,
      generated.scenarioMd,
      JSON.stringify(generated.constraints ?? []),
      JSON.stringify(generated.evaluationCriteria ?? []),
      now,
      now,
    );
  });

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

export async function updateDesignCaseAnswers(
  db: SQLiteDatabase,
  campaignId: string,
  interviewType: MockInterviewType,
  interviewLanguage: MockInterviewLanguage,
  patch: { userAnswerMd?: string | null; recommendedAnswerMd?: string | null },
): Promise<DesignCaseResult> {
  const campaign = getCampaign(db, campaignId);
  const effectiveLang = effectiveInterviewLanguage(interviewType, interviewLanguage);
  const cacheId = designCaseCacheId(campaignId, interviewType, interviewLanguage);
  const row = db.getFirstSync<DesignCaseRow>(DESIGN_CASE_SELECT, cacheId);
  if (!row) throw new Error('请先生成题目');

  const userAnswerMd = patch.userAnswerMd !== undefined ? patch.userAnswerMd : row.user_answer_md;
  const recommendedAnswerMd =
    patch.recommendedAnswerMd !== undefined ? patch.recommendedAnswerMd : row.recommended_answer_md;

  const identity = await getDeviceIdentity(db);
  const now = Date.now();
  writingAs(db, identity.deviceId, () => {
    db.runSync(
      `UPDATE design_case SET user_answer_md = ?, recommended_answer_md = ?, updated_at = ? WHERE id = ?`,
      userAnswerMd,
      recommendedAnswerMd,
      now,
      cacheId,
    );
  });

  return rowToDesignCaseResult(
    {
      ...row,
      user_answer_md: userAnswerMd,
      recommended_answer_md: recommendedAnswerMd,
    },
    campaign,
    effectiveLang,
  );
}

export async function generateRecommendedAnswer(
  db: SQLiteDatabase,
  campaignId: string,
  caseTitle: string,
  scenarioMd: string,
  interviewType: MockInterviewKind,
  interviewLanguage: MockInterviewLanguage,
  constraints: string[] = [],
): Promise<DesignGenerateAnswerResult> {
  const effectiveLang = effectiveInterviewLanguage(interviewType, interviewLanguage);
  const context = buildInterviewContext(db, campaignId);
  const constraintHint =
    constraints.length > 0 ? `\n考察点：${constraints.join(' · ')}` : '';

  const generated = await completeJson<DesignAnswerGenerated>(
    'quiz',
    'design.answer',
    `${context}

题目类型：${interviewType}
面试语言：${effectiveLang === 'en' ? '英文' : '中文'}
题目：${caseTitle}
题干：${scenarioMd}${constraintHint}`,
    undefined,
    { type: interviewType, language: effectiveLang },
  );

  return { recommendedAnswerMd: normalizeDisplayText(generated.answerMd) };
}

export async function elaborateDesignAnswer(
  selectedText: string,
  contextMd: string,
): Promise<DesignElaborateResult> {
  const text = selectedText.trim();
  if (!text) throw new Error('请先选择要细化的内容');

  const content = await completeJson<{ markdown: string }>(
    'explain',
    'explain.elaborate',
    `## 模拟面试题目与参考答案（节选）
${contextMd.slice(0, 6000)}

## 用户划选内容
${text}`,
  );

  return { elaborationMd: normalizeDisplayText(content.markdown) };
}

export async function submitDesignAnswer(
  db: SQLiteDatabase,
  campaignId: string,
  caseTitle: string,
  scenarioMd: string,
  userAnswer: string,
  interviewType: MockInterviewKind = 'design',
  interviewLanguage: MockInterviewLanguage = 'zh',
  requestedType: MockInterviewType = interviewType,
): Promise<DesignSubmitResult> {
  const effectiveLang = effectiveInterviewLanguage(interviewType, interviewLanguage);
  const context = buildInterviewContext(db, campaignId);

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
  const identity = await getDeviceIdentity(db);
  const now = Date.now();
  const snippetId = Crypto.randomUUID();

  writingAs(db, identity.deviceId, () => {
    db.runSync(
      `INSERT INTO speech_snippet (id, source_type, source_id, tier, content_md, is_user_edited, created_at)
       VALUES (?, 'design', ?, 'spoken', ?, 0, ?)`,
      snippetId,
      campaignId,
      scored.improvedOutlineMd,
      now,
    );
    const cacheId = designCaseCacheId(campaignId, requestedType, interviewLanguage);
    db.runSync(
      `UPDATE design_case SET user_answer_md = ?, updated_at = ? WHERE id = ?`,
      userAnswer,
      now,
      cacheId,
    );
  });

  return {
    score,
    feedbackMd: normalizeDisplayText(scored.feedbackMd),
    improvedOutlineMd: normalizeDisplayText(scored.improvedOutlineMd),
    speechSnippetId: snippetId,
  };
}
