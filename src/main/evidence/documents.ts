/**
 * 一场战役的文档取数，按「谁能成为候选人事实」分成两组。
 *
 * 这个模块的全部价值就是这次分组。用一个 `loadDocuments(campaignId)` 把简历、
 * JD 和公司情报一起返回，再让调用方自己记着哪几项不能进证据，是这条边界最容易
 * 破的写法——调用方只要漏判一次，用户就会拿着一段 JD 职责当成自己的项目经历
 * 去面试。所以两组文档的返回类型不同，混不到一起。
 *
 * 本模块不引用 ../db：接收 raw Database，由 IPC/RPC 层注入，真实迁移后的库
 * 可以直接进单测。
 */

import type { Database } from 'better-sqlite3';
import { pickVariantForCampaign } from '@shared/resume/campaignBinding';
import type { CandidateDocument, JobContextDocument } from '@shared/evidence';

interface CampaignRow {
  id: string;
  jd_raw: string | null;
  job_target_id: string | null;
  resume_id: string | null;
}

interface VariantRow {
  id: string;
  source_resume_id: string | null;
  content_md: string;
  created_at: number;
  updated_at: number;
}

function campaignRow(raw: Database, campaignId: string): CampaignRow | null {
  return (
    (raw
      .prepare(`SELECT id, jd_raw, job_target_id, resume_id FROM campaign WHERE id = ?`)
      .get(campaignId) as CampaignRow | undefined) ?? null
  );
}

/**
 * 候选人自述文档：证据的唯一合法来源。
 *
 * 面经只收 selfDebrief。web / pasted 那两类是别人的面试经历，读起来同样像
 * 「一段第一人称的经历」，但那不是这位候选人做过的事。
 */
export function loadCandidateDocuments(
  raw: Database,
  campaignId: string,
): CandidateDocument[] {
  const campaign = campaignRow(raw, campaignId);
  if (!campaign) throw new Error(`Campaign 不存在：${campaignId}`);

  const documents: CandidateDocument[] = [];

  if (campaign.resume_id) {
    const resume = raw
      .prepare(`SELECT id, raw_text FROM resume WHERE id = ?`)
      .get(campaign.resume_id) as { id: string; raw_text: string | null } | undefined;
    if (resume?.raw_text) {
      documents.push({ kind: 'resume', id: resume.id, text: resume.raw_text });
    }
  }

  if (campaign.job_target_id && campaign.resume_id) {
    const rows = raw
      .prepare(
        `SELECT id, source_resume_id, content_md, created_at, updated_at
         FROM resume_variant WHERE job_target_id = ?`,
      )
      .all(campaign.job_target_id) as VariantRow[];
    // 「哪份派生版算数」与 prompt 装配共用 @shared/resume/campaignBinding，
    // 否则证据会从一份、答案会从另一份取
    const picked = pickVariantForCampaign(
      rows.map((row) => ({
        id: row.id,
        sourceResumeId: row.source_resume_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      campaign.resume_id,
    );
    const hit = picked ? rows.find((row) => row.id === picked.id) : undefined;
    if (hit?.content_md) {
      documents.push({ kind: 'resumeVariant', id: hit.id, text: hit.content_md });
    }
  }

  const debriefs = raw
    .prepare(
      `SELECT id, raw_text FROM interview_report
       WHERE campaign_id = ? AND source_type = 'selfDebrief'
       ORDER BY created_at`,
    )
    .all(campaignId) as Array<{ id: string; raw_text: string | null }>;
  debriefs.forEach((row) => {
    if (row.raw_text) documents.push({ kind: 'selfReport', id: row.id, text: row.raw_text });
  });

  return documents;
}

/**
 * 岗位侧文档。
 *
 * 抽取时只用来给候选人事实排相关度。返回类型与 CandidateDocument 不通用，
 * 想把这里的内容写成证据得先绕过类型和 grounding 两道校验。
 */
export function loadJobContextDocuments(
  raw: Database,
  campaignId: string,
): JobContextDocument[] {
  const campaign = campaignRow(raw, campaignId);
  if (!campaign) throw new Error(`Campaign 不存在：${campaignId}`);

  const documents: JobContextDocument[] = [];
  if (campaign.jd_raw?.trim()) {
    documents.push({ kind: 'jd', id: campaign.id, text: campaign.jd_raw });
  }

  const intel = raw
    .prepare(
      `SELECT id, tech_stack_md, hot_topics_md FROM company_intel WHERE campaign_id = ?`,
    )
    .get(campaignId) as
    | { id: string; tech_stack_md: string; hot_topics_md: string }
    | undefined;
  if (intel) {
    const text = [intel.tech_stack_md, intel.hot_topics_md].filter(Boolean).join('\n');
    if (text.trim()) documents.push({ kind: 'company', id: intel.id, text });
  }

  return documents;
}
