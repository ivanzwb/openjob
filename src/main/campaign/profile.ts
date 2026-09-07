/**
 * 战役 prompt 装配用的候选人履历取数（派生版优先）。
 *
 * 绑定语义：campaign.resume_id 存母版；当该战役的目标岗位下存在派生自这份母版
 * 的优化版时，正文用优化版 content_md（优化只改表述与结构、事实继承母版），
 * skills/projects 结构数据仍从母版 parsed 取，避免为派生版另做一遍结构解析。
 * 桌面与移动端各自实现 SQL 取数，但「哪份算数」的判定共用
 * @shared/resume/campaignBinding。
 */
import { eq } from 'drizzle-orm';
import type { ResumeParsed } from '@shared/entities';
import { pickVariantForCampaign } from '@shared/resume/campaignBinding';
import { getDb, schema } from '../db';
import { getCampaignRow, getResumeRow } from './repository';

export interface CampaignProfile {
  /** 喂给 prompt 的正文：匹配的派生版 content_md，否则绑定母版 raw_text */
  text: string;
  /** 母版结构数据（skills/projects 等），派生版沿用 */
  parsed: ResumeParsed | null;
}

export function loadCampaignProfile(campaignId: string): CampaignProfile | null {
  const campaign = getCampaignRow(campaignId);
  if (!campaign.resumeId) return null;
  const master = getResumeRow(campaign.resumeId);
  if (!master) return null;

  const text = variantContentFor(campaign.jobTargetId, campaign.resumeId) ?? master.rawText ?? '';
  return { text, parsed: master.parsed ?? null };
}

function variantContentFor(jobTargetId: string | null, resumeId: string): string | null {
  if (!jobTargetId) return null;
  const rows = getDb()
    .select({
      id: schema.resumeVariant.id,
      sourceResumeId: schema.resumeVariant.sourceResumeId,
      contentMd: schema.resumeVariant.contentMd,
      updatedAt: schema.resumeVariant.updatedAt,
      createdAt: schema.resumeVariant.createdAt,
    })
    .from(schema.resumeVariant)
    .where(eq(schema.resumeVariant.jobTargetId, jobTargetId))
    .all();
  const hit = pickVariantForCampaign(rows, resumeId);
  if (!hit) return null;
  return rows.find((r) => r.id === hit.id)?.contentMd ?? null;
}
