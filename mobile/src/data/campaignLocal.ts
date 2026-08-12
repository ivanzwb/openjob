import type { SQLiteDatabase } from 'expo-sqlite';
import type { Campaign, KnowledgeNode, Resume } from '@shared/entities';
import type { CoverageType, ExamForm, MasterySource, NodeKind, NodeStatus } from '@shared/enums';

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
    created_at: number;
    updated_at: number;
  }>(`SELECT * FROM resume WHERE id = ?`, resumeId);
  if (!row) throw new Error('简历不存在');
  return {
    id: row.id,
    label: row.label,
    rawText: row.raw_text,
    parsed: row.parsed ? (JSON.parse(row.parsed) as Resume['parsed']) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const RESUME_ALIGN_RULES = `
## 简历对齐要求（非常重要）
- 面试问法、举例、项目经历、技术名词必须尽量与候选人简历一致，让候选人能直接用自己的经历口述。
- 优先引用简历中的公司、项目名、技术栈、职责描述；不要编造候选人没做过的项目。
- 若简历与考点关联弱，用通用框架回答，并明确标注「可换成你简历里的 XXX 项目/经历」。
- 问答示例里的背景、数据、角色要与简历角色匹配（如后端岗不要举纯前端项目为主例）。`;

export function buildResumeContext(db: SQLiteDatabase, campaignId: string): string {
  const campaign = getCampaign(db, campaignId);
  if (!campaign.resumeId) {
    return (
      '（尚未关联简历：举例用通用场景，并在实例段落提醒候选人结合自身项目替换；' +
      '不要编造具体公司名/项目名当作候选人经历）'
    );
  }

  const resume = getResume(db, campaign.resumeId);
  const parts = [`## 候选人简历原文\n${resume.rawText.slice(0, 8000)}`];
  if (resume.parsed) {
    parts.push(`## 简历结构化摘要\n${JSON.stringify(resume.parsed, null, 2).slice(0, 4000)}`);
  }
  parts.push(RESUME_ALIGN_RULES);
  return parts.join('\n\n');
}
