/**
 * 战役 prompt 装配用的候选人履历取数（派生版优先，规则与桌面端一致）。
 *
 * 单独成文件是因为 candidateContextLocal（考我/追问）与 campaignLocal
 * （考我 explain）都要用，而两者互相 import 会成环；本模块不 import 任何本地
 * 模块，只依赖共享判定 @core/resume/campaignBinding。
 *
 * 绑定语义：campaign.resume_id 存母版；当战役目标岗位下存在派生自这份母版的
 * 优化版时，正文用优化版 content_md（优化只改表述与结构、事实继承母版），
 * skills/projects 结构数据仍从母版 parsed 取。
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import {
  pickVariantForCampaign,
  type ResumeVariantBrief,
} from '@core/resume/campaignBinding';
import { skillsFromResumeMd } from '@core/resume/experienceTimeline';
import type { FallbackProject } from '@core/resume/experienceTimeline';

export interface ResumePromptFields {
  skills: string[];
  projects: FallbackProject[];
  /** 喂给 prompt 的正文：匹配的派生版 content_md，否则绑定母版 raw_text */
  rawText: string;
}

export function loadCampaignResumeForPrompt(
  db: SQLiteDatabase,
  campaign: { resumeId: string | null; jobTargetId: string | null },
): ResumePromptFields {
  const master = loadMaster(db, campaign.resumeId);
  const variantMd = variantContentFor(db, campaign);
  if (variantMd === null) return master;
  return { ...master, rawText: variantMd };
}

interface MasterRow {
  parsed: string | null;
  raw_text: string | null;
}

function loadMaster(db: SQLiteDatabase, resumeId: string | null): ResumePromptFields {
  const row = resumeId
    ? db.getFirstSync<MasterRow>(`SELECT parsed, raw_text FROM resume WHERE id = ?`, resumeId)
    : null;
  const rawText = row?.raw_text ?? '';
  let skills: string[] = [];
  if (row?.parsed) {
    try {
      const parsed = JSON.parse(row.parsed) as {
        projects?: FallbackProject[];
        skills?: string[];
      };
      skills = parsed.skills ?? [];
    } catch {
      skills = [];
    }
  }
  // parsed 缺失时从「专业技能」节兜底，让「简历技能」行不至于空着
  if (skills.length === 0) skills = skillsFromResumeMd(rawText);
  let projects: FallbackProject[] = [];
  if (row?.parsed) {
    try {
      projects = (JSON.parse(row.parsed) as { projects?: FallbackProject[] }).projects ?? [];
    } catch {
      projects = [];
    }
  }
  return { skills, projects, rawText };
}

interface VariantPromptRow {
  id: string;
  source_resume_id: string | null;
  content_md: string | null;
  updated_at: number;
  created_at: number;
}

function variantContentFor(
  db: SQLiteDatabase,
  campaign: { resumeId: string | null; jobTargetId: string | null },
): string | null {
  if (!campaign.jobTargetId || !campaign.resumeId) return null;
  const rows = db.getAllSync<VariantPromptRow>(
    `SELECT id, source_resume_id, content_md, updated_at, created_at
     FROM resume_variant WHERE job_target_id = ?`,
    campaign.jobTargetId,
  );
  const briefs: ResumeVariantBrief[] = rows.map((r) => ({
    id: r.id,
    sourceResumeId: r.source_resume_id,
    updatedAt: r.updated_at,
    createdAt: r.created_at,
  }));
  const hit = pickVariantForCampaign(briefs, campaign.resumeId);
  if (!hit) return null;
  return rows.find((r) => r.id === hit.id)?.content_md ?? null;
}
