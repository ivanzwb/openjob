import { randomUUID } from 'node:crypto';
import { getRawDb } from '../db';

/** 为历史备考战役补齐 job_target，并关联 job_target_id */
export function backfillJobTargetsFromCampaigns(): void {
  const raw = getRawDb();
  const rows = raw
    .prepare(
      `SELECT id, company, role_title, jd_raw, jd_parsed, created_at, updated_at
       FROM campaign WHERE job_target_id IS NULL`,
    )
    .all() as Array<{
    id: string;
    company: string;
    role_title: string;
    jd_raw: string;
    jd_parsed: string | null;
    created_at: number;
    updated_at: number;
  }>;

  for (const row of rows) {
    const targetId = randomUUID();
    raw
      .prepare(
        `INSERT INTO job_target (id, company, role_title, jd_raw, jd_parsed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        targetId,
        row.company,
        row.role_title,
        row.jd_raw,
        row.jd_parsed,
        row.created_at,
        row.updated_at,
      );
    raw.prepare(`UPDATE campaign SET job_target_id = ? WHERE id = ?`).run(targetId, row.id);
  }

  raw
    .prepare(`UPDATE resume SET updated_at = created_at WHERE updated_at IS NULL`)
    .run();
}
