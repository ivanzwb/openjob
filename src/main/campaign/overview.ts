import { eq, sql } from 'drizzle-orm';
import type { CampaignOverview } from '@shared/ipc';
import { getDb, schema } from '../db';
import { listCampaigns } from './repository';

export function getCampaignOverview(): CampaignOverview {
  const db = getDb();
  const campaigns = listCampaigns();

  const speechCount =
    db.select({ n: sql<number>`count(*)` }).from(schema.speechSnippet).get()?.n ?? 0;

  const blindSpotCount =
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.interviewQuestion)
      .where(eq(schema.interviewQuestion.isBlindSpot, true))
      .get()?.n ?? 0;

  const nodeRows = db
    .select({
      id: schema.knowledgeNode.id,
      campaignId: schema.knowledgeNode.campaignId,
      name: schema.knowledgeNode.name,
      mastery: schema.knowledgeNode.mastery,
      company: schema.campaign.company,
      roleTitle: schema.campaign.roleTitle,
    })
    .from(schema.knowledgeNode)
    .innerJoin(schema.campaign, eq(schema.knowledgeNode.campaignId, schema.campaign.id))
    .all();

  const weakNodes = nodeRows
    .filter((n) => n.mastery < 3)
    .sort((a, b) => a.mastery - b.mastery)
    .slice(0, 12)
    .map((n) => ({
      campaignId: n.campaignId,
      company: n.company,
      roleTitle: n.roleTitle,
      nodeId: n.id,
      nodeName: n.name,
      mastery: n.mastery,
    }));

  const reportRows = db
    .select({
      company: schema.interviewReport.company,
      campaignId: schema.interviewReport.campaignId,
    })
    .from(schema.interviewReport)
    .all();

  const byCompany = new Map<string, { campaignIds: Set<string>; reportCount: number }>();
  for (const r of reportRows) {
    const entry = byCompany.get(r.company) ?? { campaignIds: new Set(), reportCount: 0 };
    entry.reportCount++;
    if (r.campaignId) entry.campaignIds.add(r.campaignId);
    byCompany.set(r.company, entry);
  }

  const priorByCompany = [...byCompany.entries()]
    .map(([company, v]) => ({
      company,
      campaignCount: v.campaignIds.size,
      reportCount: v.reportCount,
    }))
    .sort((a, b) => b.reportCount - a.reportCount);

  const masterySum = nodeRows.reduce((s, n) => s + n.mastery, 0);
  const avgMastery = nodeRows.length ? masterySum / nodeRows.length : 0;

  return {
    campaignCount: campaigns.length,
    activeCampaignCount: campaigns.filter((c) => c.status === 'active').length,
    totalSpeechSnippets: speechCount,
    totalBlindSpots: blindSpotCount,
    avgMastery,
    campaigns,
    weakNodes,
    priorByCompany,
  };
}
