import { randomUUID } from 'node:crypto';
import { eq, desc, and } from 'drizzle-orm';
import type { ResumeVariant } from '@shared/entities';
import type { ResumeVariantView, UpdateResumeVariantInput } from '@shared/ipc';
import { getDb, schema } from '../db';
import { getJobTarget } from '../jobTarget/repository';
import { getResumeRow } from '../campaign/repository';

function rowToVariant(row: typeof schema.resumeVariant.$inferSelect): ResumeVariant {
  return {
    id: row.id,
    sourceResumeId: row.sourceResumeId,
    jobTargetId: row.jobTargetId,
    label: row.label,
    contentMd: row.contentMd,
    changelogMd: row.changelogMd,
    previewStyle: row.previewStyle ?? null,
    isUserEdited: row.isUserEdited,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listResumeVariants(filters?: {
  jobTargetId?: string;
  sourceResumeId?: string;
}): ResumeVariantView[] {
  const db = getDb();
  const rows = filters?.jobTargetId
    ? filters.sourceResumeId
      ? db
          .select()
          .from(schema.resumeVariant)
          .where(
            and(
              eq(schema.resumeVariant.jobTargetId, filters.jobTargetId),
              eq(schema.resumeVariant.sourceResumeId, filters.sourceResumeId),
            ),
          )
          .orderBy(desc(schema.resumeVariant.updatedAt))
          .all()
      : db
          .select()
          .from(schema.resumeVariant)
          .where(eq(schema.resumeVariant.jobTargetId, filters.jobTargetId))
          .orderBy(desc(schema.resumeVariant.updatedAt))
          .all()
    : filters?.sourceResumeId
      ? db
          .select()
          .from(schema.resumeVariant)
          .where(eq(schema.resumeVariant.sourceResumeId, filters.sourceResumeId))
          .orderBy(desc(schema.resumeVariant.updatedAt))
          .all()
      : db.select().from(schema.resumeVariant).orderBy(desc(schema.resumeVariant.updatedAt)).all();

  return rows.map((row) => toVariantView(row));
}

function toVariantView(row: typeof schema.resumeVariant.$inferSelect): ResumeVariantView {
  const db = getDb();
  const target = db
    .select()
    .from(schema.jobTarget)
    .where(eq(schema.jobTarget.id, row.jobTargetId))
    .get();
  const resume = db
    .select()
    .from(schema.resume)
    .where(eq(schema.resume.id, row.sourceResumeId))
    .get();
  const variant = rowToVariant(row);
  return {
    ...variant,
    company: target?.company ?? '',
    roleTitle: target?.roleTitle ?? '',
    sourceResumeLabel: resume?.label ?? '',
    sourceResumeText: resume?.rawText ?? '',
  };
}

export function getResumeVariant(id: string): ResumeVariantView {
  const row = getDb().select().from(schema.resumeVariant).where(eq(schema.resumeVariant.id, id)).get();
  if (!row) throw new Error('优化简历不存在');
  return toVariantView(row);
}

export function createResumeVariantRecord(
  sourceResumeId: string,
  jobTargetId: string,
  label: string,
  contentMd: string,
  changelogMd: string,
  isUserEdited = false,
): ResumeVariantView {
  const db = getDb();
  const now = Date.now();
  const row = {
    id: randomUUID(),
    sourceResumeId,
    jobTargetId,
    label: label.trim(),
    contentMd,
    changelogMd,
    isUserEdited,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(schema.resumeVariant).values(row).run();
  return getResumeVariant(row.id);
}

export function updateResumeVariant(input: UpdateResumeVariantInput): ResumeVariantView {
  const db = getDb();
  const existing = db
    .select()
    .from(schema.resumeVariant)
    .where(eq(schema.resumeVariant.id, input.id))
    .get();
  if (!existing) throw new Error('优化简历不存在');

  const now = Date.now();
  db.update(schema.resumeVariant)
    .set({
      label: input.label?.trim() ?? existing.label,
      contentMd: input.contentMd?.trim() ?? existing.contentMd,
      changelogMd: input.changelogMd ?? existing.changelogMd,
      previewStyle: input.previewStyle !== undefined ? input.previewStyle : existing.previewStyle,
      isUserEdited:
        input.contentMd !== undefined || input.previewStyle !== undefined
          ? true
          : existing.isUserEdited,
      updatedAt: now,
    })
    .where(eq(schema.resumeVariant.id, input.id))
    .run();

  return getResumeVariant(input.id);
}

export function deleteResumeVariant(id: string): void {
  getDb().delete(schema.resumeVariant).where(eq(schema.resumeVariant.id, id)).run();
}

export function getSourceResumeText(sourceResumeId: string): string {
  return getResumeRow(sourceResumeId).rawText;
}

export function getJobTargetForOptimize(jobTargetId: string) {
  return getJobTarget(jobTargetId);
}
