import { randomUUID } from 'node:crypto';
import { eq, desc } from 'drizzle-orm';
import type { JobTarget, JdParsed } from '@shared/entities';
import type { CreateJobTargetInput, UpdateJobTargetInput } from '@shared/ipc';
import { getDb, schema } from '../db';

function rowToJobTarget(row: typeof schema.jobTarget.$inferSelect): JobTarget {
  return {
    id: row.id,
    company: row.company,
    roleTitle: row.roleTitle,
    jdRaw: row.jdRaw,
    jdParsed: row.jdParsed ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 更新目标岗位时，同步已关联备考战役上的冗余字段 */
function propagateToCampaigns(jobTargetId: string, company: string, roleTitle: string, jdRaw: string): void {
  const db = getDb();
  const now = Date.now();
  db.update(schema.campaign)
    .set({ company, roleTitle, jdRaw, updatedAt: now })
    .where(eq(schema.campaign.jobTargetId, jobTargetId))
    .run();
}

export function listJobTargets(): JobTarget[] {
  return getDb()
    .select()
    .from(schema.jobTarget)
    .orderBy(desc(schema.jobTarget.updatedAt))
    .all()
    .map(rowToJobTarget);
}

export function getJobTarget(id: string): JobTarget {
  const row = getDb().select().from(schema.jobTarget).where(eq(schema.jobTarget.id, id)).get();
  if (!row) throw new Error('目标岗位不存在');
  return rowToJobTarget(row);
}

export function createJobTarget(input: CreateJobTargetInput): JobTarget {
  const db = getDb();
  const now = Date.now();
  const row = {
    id: randomUUID(),
    company: input.company.trim(),
    roleTitle: input.roleTitle.trim() || '未命名岗位',
    jdRaw: input.jdRaw.trim(),
    jdParsed: null,
    createdAt: now,
    updatedAt: now,
  };
  if (!row.company || !row.jdRaw) throw new Error('公司和 JD 为必填');
  db.insert(schema.jobTarget).values(row).run();
  return rowToJobTarget(row);
}

export function updateJobTarget(input: UpdateJobTargetInput): JobTarget {
  const db = getDb();
  const existing = db.select().from(schema.jobTarget).where(eq(schema.jobTarget.id, input.id)).get();
  if (!existing) throw new Error('目标岗位不存在');

  const company = input.company?.trim() ?? existing.company;
  const roleTitle = input.roleTitle?.trim() ?? existing.roleTitle;
  const jdRaw = input.jdRaw?.trim() ?? existing.jdRaw;
  const now = Date.now();

  db.update(schema.jobTarget)
    .set({
      company,
      roleTitle,
      jdRaw,
      jdParsed: input.jdParsed !== undefined ? input.jdParsed : existing.jdParsed,
      updatedAt: now,
    })
    .where(eq(schema.jobTarget.id, input.id))
    .run();

  propagateToCampaigns(input.id, company, roleTitle, jdRaw);

  return getJobTarget(input.id);
}

export function saveJobTargetJdParsed(id: string, parsed: JdParsed): void {
  getDb()
    .update(schema.jobTarget)
    .set({ jdParsed: parsed, updatedAt: Date.now() })
    .where(eq(schema.jobTarget.id, id))
    .run();
}

export function deleteJobTarget(id: string): void {
  const db = getDb();
  const linked = db
    .select({ id: schema.campaign.id })
    .from(schema.campaign)
    .where(eq(schema.campaign.jobTargetId, id))
    .all();
  if (linked.length > 0) {
    throw new Error(`仍有 ${linked.length} 场备考关联此岗位，请先解除或删除备考`);
  }
  db.delete(schema.jobTarget).where(eq(schema.jobTarget.id, id)).run();
}

export function linkCampaignToJobTarget(campaignId: string, jobTargetId: string): void {
  const target = getJobTarget(jobTargetId);
  const now = Date.now();
  getDb()
    .update(schema.campaign)
    .set({
      jobTargetId,
      company: target.company,
      roleTitle: target.roleTitle,
      jdRaw: target.jdRaw,
      jdParsed: target.jdParsed,
      updatedAt: now,
    })
    .where(eq(schema.campaign.id, campaignId))
    .run();
}
