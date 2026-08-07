import { eq } from 'drizzle-orm';
import type { CampaignCompareResult } from '@shared/ipc';
import { getDb, schema } from '../db';
import { getCampaignRow } from './repository';

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

export function compareCampaigns(
  campaignIdA: string,
  campaignIdB: string,
): CampaignCompareResult {
  const a = getCampaignRow(campaignIdA);
  const b = getCampaignRow(campaignIdB);
  const db = getDb();

  const nodesA = db
    .select()
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.campaignId, campaignIdA))
    .all();
  const nodesB = db
    .select()
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.campaignId, campaignIdB))
    .all();

  const mapB = new Map(nodesB.map((n) => [normalizeName(n.name), n]));
  const overlaps: CampaignCompareResult['overlaps'] = [];
  const onlyA: CampaignCompareResult['onlyA'] = [];
  const onlyBNames = new Set(nodesB.map((n) => normalizeName(n.name)));

  for (const na of nodesA) {
    const key = normalizeName(na.name);
    const nb = mapB.get(key);
    if (nb) {
      overlaps.push({
        nodeName: na.name,
        masteryA: na.mastery,
        masteryB: nb.mastery,
        examProbA: na.examProb,
        examProbB: nb.examProb,
      });
      onlyBNames.delete(key);
    } else {
      onlyA.push({ nodeName: na.name, mastery: na.mastery, examProb: na.examProb });
    }
  }

  const onlyB = nodesB
    .filter((n) => onlyBNames.has(normalizeName(n.name)))
    .map((n) => ({ nodeName: n.name, mastery: n.mastery, examProb: n.examProb }));

  const avg = (vals: number[]): number =>
    vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;

  return {
    campaignA: { id: a.id, company: a.company, roleTitle: a.roleTitle },
    campaignB: { id: b.id, company: b.company, roleTitle: b.roleTitle },
    overlaps: overlaps.sort((x, y) => x.masteryA + x.masteryB - (y.masteryA + y.masteryB)),
    onlyA,
    onlyB,
    avgMasteryA: avg(nodesA.map((n) => n.mastery)),
    avgMasteryB: avg(nodesB.map((n) => n.mastery)),
  };
}
