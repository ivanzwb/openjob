/**
 * candidate_evidence 的取数与写入。
 *
 * 与 plugins/runtime.ts 同样接收 raw Database，不引用 ../db。
 */

import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { CandidateEvidence } from '@shared/entities';
import type { EvidenceProposal, EvidenceScope } from '@shared/evidence';
import type { CandidateEvidenceKind, CandidateSourceKind, EvidenceStatus } from '@shared/enums';

interface EvidenceRow {
  id: string;
  campaign_id: string;
  kind: string;
  title: string;
  statement: string;
  source_kind: string;
  source_document_id: string;
  source_start: number;
  source_end: number;
  source_text: string;
  occurred_at: string | null;
  confidence: number;
  status: string;
  created_at: number;
  updated_at: number;
}

const COLUMNS = `id, campaign_id, kind, title, statement, source_kind, source_document_id,
                 source_start, source_end, source_text, occurred_at, confidence, status,
                 created_at, updated_at`;

export function rowToEvidence(row: EvidenceRow): CandidateEvidence {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    kind: row.kind as CandidateEvidenceKind,
    title: row.title,
    statement: row.statement,
    source: {
      kind: row.source_kind as CandidateSourceKind,
      documentId: row.source_document_id,
      start: row.source_start,
      end: row.source_end,
      quote: row.source_text,
    },
    occurredAt: row.occurred_at,
    confidence: row.confidence,
    status: row.status as EvidenceStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getEvidence(raw: Database, id: string): CandidateEvidence | null {
  const row = raw
    .prepare(`SELECT ${COLUMNS} FROM candidate_evidence WHERE id = ?`)
    .get(id) as EvidenceRow | undefined;
  return row ? rowToEvidence(row) : null;
}

function listByStatus(
  raw: Database,
  scope: EvidenceScope,
  statuses: readonly EvidenceStatus[],
): CandidateEvidence[] {
  const conditions = ['campaign_id = ?'];
  const args: unknown[] = [scope.campaignId];

  conditions.push(`status IN (${statuses.map(() => '?').join(', ')})`);
  args.push(...statuses);

  if (scope.sourceKinds && scope.sourceKinds.length > 0) {
    conditions.push(`source_kind IN (${scope.sourceKinds.map(() => '?').join(', ')})`);
    args.push(...scope.sourceKinds);
  }
  if (scope.kinds && scope.kinds.length > 0) {
    conditions.push(`kind IN (${scope.kinds.map(() => '?').join(', ')})`);
    args.push(...scope.kinds);
  }

  const rows = raw
    .prepare(
      `SELECT ${COLUMNS} FROM candidate_evidence
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at, id`,
    )
    .all(...args) as EvidenceRow[];
  return rows.map(rowToEvidence);
}

/** 只返回已确认项。proposed / rejected 永远不从这个函数流出去 */
export function listConfirmedEvidence(
  raw: Database,
  scope: EvidenceScope,
): CandidateEvidence[] {
  return listByStatus(raw, scope, ['confirmed']);
}

/** 待确认列表，供 UI 逐条确认或拒绝 */
export function listProposedEvidence(
  raw: Database,
  scope: EvidenceScope,
): CandidateEvidence[] {
  return listByStatus(raw, scope, ['proposed']);
}

export interface InsertProposalOptions {
  now?: () => number;
  newId?: () => string;
}

/**
 * 落一条待确认的证据。
 *
 * 同一段原文重复抽取时返回已有那条而不是插一条新的：抽取是可重跑的，用户
 * 确认过的状态不能因为重跑一次就退回 proposed，被拒过的也不该再冒出来。
 */
export function insertProposal(
  raw: Database,
  proposal: EvidenceProposal,
  options: InsertProposalOptions = {},
): CandidateEvidence {
  const existing = raw
    .prepare(
      `SELECT ${COLUMNS} FROM candidate_evidence
       WHERE campaign_id = ? AND kind = ? AND source_kind = ?
         AND source_document_id = ? AND source_start = ? AND source_end = ?`,
    )
    .get(
      proposal.campaignId,
      proposal.kind,
      proposal.source.kind,
      proposal.source.documentId,
      proposal.source.start,
      proposal.source.end,
    ) as EvidenceRow | undefined;
  if (existing) return rowToEvidence(existing);

  const id = options.newId?.() ?? randomUUID();
  const timestamp = options.now?.() ?? Date.now();
  raw
    .prepare(
      `INSERT INTO candidate_evidence (
         id, campaign_id, kind, title, statement, source_kind, source_document_id,
         source_start, source_end, source_text, occurred_at, confidence, status,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`,
    )
    .run(
      id,
      proposal.campaignId,
      proposal.kind,
      proposal.title,
      proposal.statement,
      proposal.source.kind,
      proposal.source.documentId,
      proposal.source.start,
      proposal.source.end,
      proposal.source.quote,
      proposal.occurredAt,
      proposal.confidence,
      timestamp,
      timestamp,
    );

  const inserted = getEvidence(raw, id);
  if (!inserted) throw new Error(`证据写入后不可读：${id}`);
  return inserted;
}

export function setEvidenceStatus(
  raw: Database,
  id: string,
  status: EvidenceStatus,
  now = Date.now(),
): void {
  raw
    .prepare(`UPDATE candidate_evidence SET status = ?, updated_at = ? WHERE id = ?`)
    .run(status, now, id);
}
