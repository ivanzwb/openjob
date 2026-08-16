import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { JdDiagnosisResult } from '@shared/diagnosis/prompts';
import { flattenGeneratedTree } from '@shared/diagnosis/tree';
import { completeJson } from '../llm/json';
import { getCampaign } from './campaignLocal';
import {
  applyHistoricalPrior,
  clearCampaignNodes,
  insertEdgesByName,
  insertNodes,
  refreshAllPriorities,
  saveJdParsed,
  updateCampaignFields,
} from './nodesLocal';
import { getDeviceIdentity } from '../sync/identity';
import { writingAs } from '../sync/triggers';
import { searchWeb } from '../search';

export async function diagnoseFromJd(db: SQLiteDatabase, campaignId: string): Promise<string> {
  const campaign = getCampaign(db, campaignId);
  if (!campaign.jdRaw.trim()) throw new Error('JD 内容为空');

  const result = await completeJson<JdDiagnosisResult>(
    'outline',
    'diagnosis.jd',
    `公司：${campaign.company}\n岗位：${campaign.roleTitle}\n\nJD：\n${campaign.jdRaw}`,
  );

  const identity = await getDeviceIdentity(db);
  writingAs(db, identity.deviceId, () => {
    clearCampaignNodes(db, campaignId);
    saveJdParsed(db, campaignId, result.jdParsed);
    insertNodes(db, flattenGeneratedTree(campaignId, result.nodes));
  });

  const edgesCreated = await insertEdgesByName(db, campaignId, result.edges ?? []);
  refreshAllPriorities(db, campaignId);
  const priorBoosted = applyHistoricalPrior(db, campaignId, campaign.company);
  updateCampaignFields(db, {
    id: campaignId,
    roleTitle: result.jdParsed.roleTitle || campaign.roleTitle,
  });

  const rowCount = db.getFirstSync<{ n: number }>(
    `SELECT count(*) AS n FROM knowledge_node WHERE campaign_id = ?`,
    campaignId,
  )?.n ?? 0;

  return (
    `已生成 ${rowCount} 个考点` +
    (edgesCreated > 0 ? `、${edgesCreated} 条关系` : '') +
    (priorBoosted > 0 ? `，${priorBoosted} 个考点已应用历史真题先验` : '')
  );
}

export async function diagnoseFetchIntel(db: SQLiteDatabase, campaignId: string): Promise<string> {
  const campaign = getCampaign(db, campaignId);
  const query = `${campaign.company} ${campaign.roleTitle} 面试 面经 流程`;

  const searchRes = await searchWeb(query, { freshness: 'oneYear', count: 8 });
  const context = searchRes.results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}\n${(r.contentMd ?? '').slice(0, 800)}`)
    .join('\n\n---\n\n');

  const intel = await completeJson<{
    techStackMd: string;
    interviewProcessMd: string;
    hotTopicsMd: string;
    talkingPointsMd: string;
  }>(
    'outline',
    'diagnosis.intel',
    `公司：${campaign.company}\n岗位：${campaign.roleTitle}\n\n检索结果：\n${context}`,
  );

  const identity = await getDeviceIdentity(db);
  const now = Date.now();
  const existing = db.getFirstSync<{ id: string }>(
    `SELECT id FROM company_intel WHERE campaign_id = ?`,
    campaignId,
  );

  writingAs(db, identity.deviceId, () => {
    if (existing) {
      db.runSync(
        `UPDATE company_intel SET tech_stack_md = ?, interview_process_md = ?, hot_topics_md = ?, talking_points_md = ?, updated_at = ? WHERE id = ?`,
        intel.techStackMd,
        intel.interviewProcessMd,
        intel.hotTopicsMd,
        intel.talkingPointsMd,
        now,
        existing.id,
      );
    } else {
      db.runSync(
        `INSERT INTO company_intel (id, campaign_id, tech_stack_md, interview_process_md, hot_topics_md, talking_points_md, source_ids, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '[]', ?)`,
        Crypto.randomUUID(),
        campaignId,
        intel.techStackMd,
        intel.interviewProcessMd,
        intel.hotTopicsMd,
        intel.talkingPointsMd,
        now,
      );
    }
  });

  return '公司情报卡已更新';
}
