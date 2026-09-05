import type { SQLiteDatabase } from 'expo-sqlite';
import type { Campaign, KnowledgeNode, Resume } from '@shared/entities';
import type { CoverageType, ExamForm, MasterySource, NodeKind, NodeStatus } from '@shared/enums';
import { buildExplainResumeContext } from '@shared/prompts/candidateContext';
import type { ResumeRelevanceQuery } from '@shared/resume/relevance';

type NodeRow = {
  id: string;
  campaign_id: string;
  parent_id: string | null;
  name: string;
  kind: string;
  coverage_type: string;
  exam_prob: number;
  difficulty: number;
  est_minutes: number;
  exam_forms: string;
  mastery: number;
  mastery_source: string;
  priority_score: number;
  status: string;
  is_user_added: number;
  quiz_question_md: string | null;
  quiz_recommended_answer_md: string | null;
  created_at: number;
};

function rowToNode(row: NodeRow): KnowledgeNode {
  let examForms: ExamForm[] = [];
  try {
    examForms = JSON.parse(row.exam_forms) as ExamForm[];
  } catch {
    examForms = [];
  }
  return {
    id: row.id,
    campaignId: row.campaign_id,
    parentId: row.parent_id,
    name: row.name,
    kind: row.kind as NodeKind,
    coverageType: row.coverage_type as CoverageType,
    examProb: row.exam_prob,
    difficulty: row.difficulty,
    estMinutes: row.est_minutes,
    examForms,
    mastery: row.mastery,
    masterySource: row.mastery_source as MasterySource,
    priorityScore: row.priority_score,
    status: row.status as NodeStatus,
    embedding: null,
    isUserAdded: Boolean(row.is_user_added),
    quizQuestionMd: row.quiz_question_md ?? null,
    quizRecommendedAnswerMd: row.quiz_recommended_answer_md ?? null,
    createdAt: row.created_at,
  };
}

export function getKnowledgeNode(db: SQLiteDatabase, nodeId: string): KnowledgeNode {
  const row = db.getFirstSync<NodeRow>(`SELECT * FROM knowledge_node WHERE id = ?`, nodeId);
  if (!row) throw new Error('考点不存在');
  return rowToNode(row);
}

export function getCampaign(db: SQLiteDatabase, campaignId: string): Campaign {
  const row = db.getFirstSync<{
    id: string;
    company: string;
    role_title: string;
    jd_raw: string;
    jd_parsed: string | null;
    job_target_id: string | null;
    role_profile_id: string | null;
    resume_id: string | null;
    interview_date: string | null;
    daily_minutes: number | null;
    status: string;
    created_at: number;
    updated_at: number;
  }>(`SELECT * FROM campaign WHERE id = ?`, campaignId);
  if (!row) throw new Error('Campaign 不存在');
  return {
    id: row.id,
    company: row.company,
    roleTitle: row.role_title,
    jdRaw: row.jd_raw,
    jdParsed: row.jd_parsed ? (JSON.parse(row.jd_parsed) as Campaign['jdParsed']) : null,
    jobTargetId: row.job_target_id,
    roleProfileId: row.role_profile_id,
    resumeId: row.resume_id,
    interviewDate: row.interview_date,
    dailyMinutes: row.daily_minutes,
    status: row.status as Campaign['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getResume(db: SQLiteDatabase, resumeId: string): Resume {
  const row = db.getFirstSync<{
    id: string;
    label: string;
    raw_text: string;
    parsed: string | null;
    preview_style: string | null;
    photo: string | null;
    created_at: number;
    updated_at: number;
  }>(`SELECT * FROM resume WHERE id = ?`, resumeId);
  if (!row) throw new Error('简历不存在');
  return {
    id: row.id,
    label: row.label,
    rawText: row.raw_text,
    parsed: row.parsed ? (JSON.parse(row.parsed) as Resume['parsed']) : null,
    previewStyle: row.preview_style ?? null,
    photo: row.photo ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 措辞和筛选都在共享层（桌面端调同一个函数），这里只负责取数。
 * query 决定从简历里挑哪几段，所以每个调用点都要把考点名和用户这轮的输入传进来。
 */
export function buildResumeContext(
  db: SQLiteDatabase,
  campaignId: string,
  query: ResumeRelevanceQuery,
): string {
  const campaign = getCampaign(db, campaignId);
  if (!campaign.resumeId) return buildExplainResumeContext(null, query);

  const resume = getResume(db, campaign.resumeId);
  return buildExplainResumeContext(
    {
      resumeRawText: resume.rawText,
      resumeSkills: resume.parsed?.skills ?? null,
      resumeProjects: resume.parsed?.projects ?? null,
    },
    query,
  );
}
