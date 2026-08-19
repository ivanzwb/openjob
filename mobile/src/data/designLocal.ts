import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { DesignCaseResult, DesignSubmitResult } from '@shared/ipc';
import type { ExamForm } from '@shared/enums';
import {
  caseUserHintForType,
  type DesignCaseGenerated,
  type DesignScoreGenerated,
  type MockInterviewKind,
  type MockInterviewLanguage,
  type MockInterviewType,
} from '@shared/design/prompts';
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
}

function designCaseCacheId(
  campaignId: string,
  interviewType: MockInterviewType,
  interviewLanguage: MockInterviewLanguage,
): string {
  return `${campaignId}:${interviewType}:${interviewLanguage}`;
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
    ? db.getFirstSync<{ parsed: string | null }>(`SELECT parsed FROM resume WHERE id = ?`, campaign.resumeId)
    : null;

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

  let projectSummary = '（未提供）';
  if (resume?.parsed) {
    try {
      const parsed = JSON.parse(resume.parsed) as {
        projects?: { name: string; summary: string; drillableTopics: string[] }[];
        skills?: string[];
      };
      projectSummary =
        parsed.projects
          ?.slice(0, 4)
          .map((p) => `${p.name}：${p.summary}；可深挖：${p.drillableTopics.slice(0, 4).join('、')}`)
          .join('\n') ?? '（未提供）';
    } catch {
      projectSummary = '（未提供）';
    }
  }

  return `公司：${campaign.company}
岗位：${campaign.roleTitle}
JD 摘要：${jdSummary}
简历技能：${resume?.parsed ? (JSON.parse(resume.parsed) as { skills?: string[] }).skills?.join('、') ?? '（未提供）' : '（未提供）'}
简历项目：
${projectSummary}
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

export async function generateDesignCase(
  db: SQLiteDatabase,
  campaignId: string,
  interviewType: MockInterviewType = 'mixed',
  interviewLanguage: MockInterviewLanguage = 'zh',
  force = false,
): Promise<DesignCaseResult> {
  const campaign = getCampaign(db, campaignId);
  const cacheId = designCaseCacheId(campaignId, interviewType, interviewLanguage);
  const cached = db.getFirstSync<DesignCaseRow>(
    `SELECT campaign_id, interview_type, related_node_name, title, scenario_md, constraints, evaluation_criteria
     FROM design_case WHERE id = ?`,
    cacheId,
  );

  if (cached && !force) {
    return rowToDesignCaseResult(cached, campaign, interviewLanguage);
  }

  const context = buildInterviewContext(db, campaignId);

  const generated = await completeJson<DesignCaseGenerated>(
    'quiz',
    'design.case',
    `${context}\n\n${caseUserHintForType(interviewType, interviewLanguage)}`,
    undefined,
    { type: interviewType, language: interviewLanguage },
  );

  const identity = await getDeviceIdentity(db);
  const now = Date.now();
  writingAs(db, identity.deviceId, () => {
    db.runSync(
      `INSERT INTO design_case (
        id, campaign_id, requested_type, interview_type, related_node_name, title,
        scenario_md, constraints, evaluation_criteria, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        interview_type = excluded.interview_type,
        related_node_name = excluded.related_node_name,
        title = excluded.title,
        scenario_md = excluded.scenario_md,
        constraints = excluded.constraints,
        evaluation_criteria = excluded.evaluation_criteria,
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
    interviewLanguage,
    relatedNodeName: generated.relatedNodeName ?? null,
    title: generated.title,
    scenarioMd: generated.scenarioMd,
    constraints: generated.constraints ?? [],
    evaluationCriteria: generated.evaluationCriteria ?? [],
  };
}

export async function submitDesignAnswer(
  db: SQLiteDatabase,
  campaignId: string,
  caseTitle: string,
  scenarioMd: string,
  userAnswer: string,
  interviewType: MockInterviewKind = 'design',
  interviewLanguage: MockInterviewLanguage = 'zh',
): Promise<DesignSubmitResult> {
  const context = buildInterviewContext(db, campaignId);

  const scored = await completeJson<DesignScoreGenerated>(
    'quiz',
    'design.score',
    `${context}

题目类型：${interviewType}
面试语言：${interviewLanguage === 'en' ? '英文' : '中文'}
题目：${caseTitle}
题干：${scenarioMd}
候选人回答：${userAnswer}`,
    undefined,
    { type: interviewType, language: interviewLanguage },
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
  });

  return {
    score,
    feedbackMd: scored.feedbackMd,
    improvedOutlineMd: scored.improvedOutlineMd,
    speechSnippetId: snippetId,
  };
}
