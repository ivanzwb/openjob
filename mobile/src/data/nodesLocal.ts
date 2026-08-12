import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { JdParsed } from '@shared/entities';
import type { EdgeRelation } from '@shared/enums';
import type { KnowledgeNodeInsert } from '@shared/diagnosis/tree';
import { computePriority } from '@shared/priority';
import { getDeviceIdentity } from '../sync/identity';
import { writingAs } from '../sync/triggers';
import { getKnowledgeNode } from './campaignLocal';

export function clearCampaignNodes(db: SQLiteDatabase, campaignId: string): void {
  db.runSync(`DELETE FROM knowledge_node WHERE campaign_id = ?`, campaignId);
}

export function insertNodes(db: SQLiteDatabase, nodes: KnowledgeNodeInsert[]): void {
  for (const node of nodes) {
    const score = Number.isFinite(node.priorityScore) ? node.priorityScore : 0;
    db.runSync(
      `INSERT INTO knowledge_node (
        id, campaign_id, parent_id, name, kind, coverage_type, exam_prob, difficulty,
        est_minutes, exam_forms, mastery, mastery_source, priority_score, status, is_user_added, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      node.id,
      node.campaignId,
      node.parentId,
      node.name,
      node.kind,
      node.coverageType,
      node.examProb,
      node.difficulty,
      node.estMinutes,
      JSON.stringify(node.examForms),
      node.mastery,
      node.masterySource,
      score,
      node.status,
      node.isUserAdded ? 1 : 0,
      node.createdAt,
    );
  }
}

export function saveJdParsed(db: SQLiteDatabase, campaignId: string, parsed: JdParsed): void {
  db.runSync(`UPDATE campaign SET jd_parsed = ? WHERE id = ?`, JSON.stringify(parsed), campaignId);
}

export function updateCampaignFields(
  db: SQLiteDatabase,
  fields: {
    id: string;
    roleTitle?: string;
    resumeId?: string | null;
    interviewDate?: string | null;
    dailyMinutes?: number | null;
    status?: string;
  },
): void {
  const sets: string[] = ['updated_at = ?'];
  const vals: (string | number | null)[] = [Date.now()];
  if (fields.roleTitle !== undefined) {
    sets.push('role_title = ?');
    vals.push(fields.roleTitle);
  }
  if (fields.resumeId !== undefined) {
    sets.push('resume_id = ?');
    vals.push(fields.resumeId);
  }
  if (fields.interviewDate !== undefined) {
    sets.push('interview_date = ?');
    vals.push(fields.interviewDate);
  }
  if (fields.dailyMinutes !== undefined) {
    sets.push('daily_minutes = ?');
    vals.push(fields.dailyMinutes);
  }
  if (fields.status !== undefined) {
    sets.push('status = ?');
    vals.push(fields.status);
  }
  vals.push(fields.id);
  db.runSync(`UPDATE campaign SET ${sets.join(', ')} WHERE id = ?`, ...vals);
}

export function refreshAllPriorities(db: SQLiteDatabase, campaignId: string): void {
  const rows = db.getAllSync<{
    id: string;
    coverage_type: string;
    exam_prob: number;
    mastery: number;
    est_minutes: number;
  }>(`SELECT id, coverage_type, exam_prob, mastery, est_minutes FROM knowledge_node WHERE campaign_id = ?`, campaignId);
  for (const row of rows) {
    const { score } = computePriority({
      id: row.id,
      coverageType: row.coverage_type as KnowledgeNodeInsert['coverageType'],
      examProb: row.exam_prob,
      mastery: row.mastery,
      estMinutes: row.est_minutes,
    });
    db.runSync(`UPDATE knowledge_node SET priority_score = ? WHERE id = ?`, score, row.id);
  }
}

export async function insertEdgesByName(
  db: SQLiteDatabase,
  campaignId: string,
  specs: Array<{ from: string; to: string; relation: EdgeRelation }>,
): Promise<number> {
  if (specs.length === 0) return 0;
  const nodes = db.getAllSync<{ id: string; name: string }>(
    `SELECT id, name FROM knowledge_node WHERE campaign_id = ?`,
    campaignId,
  );
  if (nodes.length === 0) return 0;
  const idByName = new Map(nodes.map((n) => [n.name.trim().toLowerCase(), n.id]));
  const existing = db.getAllSync<{ from_node_id: string; to_node_id: string; relation: string }>(
    `SELECT e.from_node_id, e.to_node_id, e.relation FROM node_edge e
     INNER JOIN knowledge_node n ON n.id = e.from_node_id WHERE n.campaign_id = ?`,
    campaignId,
  );
  const known = new Set(existing.map((e) => `${e.from_node_id}|${e.to_node_id}|${e.relation}`));
  const identity = await getDeviceIdentity(db);
  let created = 0;
  writingAs(db, identity.deviceId, () => {
    for (const spec of specs) {
      const fromId = idByName.get(spec.from.trim().toLowerCase());
      const toId = idByName.get(spec.to.trim().toLowerCase());
      if (!fromId || !toId || fromId === toId) continue;
      const key = `${fromId}|${toId}|${spec.relation}`;
      if (known.has(key)) continue;
      known.add(key);
      db.runSync(
        `INSERT INTO node_edge (id, from_node_id, to_node_id, relation) VALUES (?, ?, ?, ?)`,
        Crypto.randomUUID(),
        fromId,
        toId,
        spec.relation,
      );
      created++;
    }
  });
  return created;
}

export function applyHistoricalPrior(
  db: SQLiteDatabase,
  campaignId: string,
  company: string,
): number {
  const reports = db
    .getAllSync<{ id: string; credibility_weight: number }>(
      `SELECT id, credibility_weight FROM interview_report WHERE company = ? AND (campaign_id IS NULL OR campaign_id != ?)`,
      company,
      campaignId,
    );
  if (reports.length === 0) return 0;

  const reportIds = new Set(reports.map((r) => r.id));
  const reportWeight = new Map(reports.map((r) => [r.id, r.credibility_weight]));
  const questions = db
    .getAllSync<{ report_id: string; matched_node_id: string | null }>(
      `SELECT report_id, matched_node_id FROM interview_question WHERE matched_node_id IS NOT NULL`,
    )
    .filter((q) => reportIds.has(q.report_id));

  const nodeNames = new Map<string, number>();
  for (const q of questions) {
    if (!q.matched_node_id) continue;
    const node = db.getFirstSync<{ name: string }>(`SELECT name FROM knowledge_node WHERE id = ?`, q.matched_node_id);
    if (!node) continue;
    const w = reportWeight.get(q.report_id) ?? 0.8;
    nodeNames.set(node.name, Math.max(nodeNames.get(node.name) ?? 0, w));
  }

  const BASE_PROB_BOOST = 0.08;
  let boosted = 0;
  const campaignNodes = db.getAllSync<{
    id: string;
    name: string;
    exam_prob: number;
    coverage_type: string;
    mastery: number;
    est_minutes: number;
  }>(`SELECT id, name, exam_prob, coverage_type, mastery, est_minutes FROM knowledge_node WHERE campaign_id = ?`, campaignId);

  for (const row of campaignNodes) {
    const weight = nodeNames.get(row.name);
    if (!weight) continue;
    const nextProb = Math.min(1, row.exam_prob + BASE_PROB_BOOST * weight);
    if (nextProb === row.exam_prob) continue;
    const { score } = computePriority({
      id: row.id,
      coverageType: row.coverage_type as KnowledgeNodeInsert['coverageType'],
      examProb: nextProb,
      mastery: row.mastery,
      estMinutes: row.est_minutes,
    });
    db.runSync(`UPDATE knowledge_node SET exam_prob = ?, priority_score = ? WHERE id = ?`, nextProb, score, row.id);
    boosted++;
  }
  return boosted;
}

export function getNodeById(db: SQLiteDatabase, nodeId: string) {
  return getKnowledgeNode(db, nodeId);
}
