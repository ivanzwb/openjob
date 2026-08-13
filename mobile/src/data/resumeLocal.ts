import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { Resume } from '@shared/entities';
import { structureResumeText } from '@shared/resume/importStructure';
import { getDeviceIdentity } from '../sync/identity';
import { writingAs } from '../sync/triggers';

/**
 * 简历的本地读写。母版（resume.raw_text）与优化版（resume_variant.content_md）
 * 正文格式一致，界面按同一套结构化编辑器处理，这里统一成 ResumeEntry。
 */
export type ResumeEntryKind = 'resume' | 'variant';

export interface ResumeEntry {
  kind: ResumeEntryKind;
  id: string;
  /** 列表主标题：母版是名称，优化版是「公司 · 岗位」 */
  label: string;
  /** 列表副标题：母版是更新时间，优化版是来源母版 */
  subtitle: string;
  contentMd: string;
  previewStyle: string | null;
  updatedAt: number;
  /** 导出 PDF 时的抬头 */
  headline: string;
  /** 导出 PDF 时的副标题与文件名 */
  fileStem: string;
}

interface ResumeRow {
  id: string;
  label: string;
  raw_text: string;
  preview_style: string | null;
  updated_at: number;
}

interface VariantRow {
  id: string;
  label: string;
  content_md: string;
  preview_style: string | null;
  updated_at: number;
  company: string | null;
  role_title: string | null;
  source_label: string | null;
}

function formatUpdatedAt(ts: number): string {
  return new Date(ts).toLocaleString();
}

export function listResumeEntries(db: SQLiteDatabase): ResumeEntry[] {
  const resumes = db.getAllSync<ResumeRow>(
    `SELECT id, label, raw_text, preview_style, updated_at FROM resume`,
  );
  const variants = db.getAllSync<VariantRow>(
    `SELECT v.id, v.label, v.content_md, v.preview_style, v.updated_at,
            t.company AS company, t.role_title AS role_title, r.label AS source_label
       FROM resume_variant v
       LEFT JOIN job_target t ON t.id = v.job_target_id
       LEFT JOIN resume r ON r.id = v.source_resume_id`,
  );

  const entries: ResumeEntry[] = resumes.map((row) => ({
    kind: 'resume',
    id: row.id,
    label: row.label,
    subtitle: `母版 · 更新于 ${formatUpdatedAt(row.updated_at)}`,
    contentMd: row.raw_text,
    previewStyle: row.preview_style,
    updatedAt: row.updated_at,
    headline: row.label,
    fileStem: row.label || '母版',
  }));

  for (const row of variants) {
    const target = [row.company, row.role_title].filter(Boolean).join(' · ');
    entries.push({
      kind: 'variant',
      id: row.id,
      label: target || row.label,
      subtitle: row.source_label ? `源自 ${row.source_label}` : '优化版',
      contentMd: row.content_md,
      previewStyle: row.preview_style,
      updatedAt: row.updated_at,
      headline: row.label,
      fileStem: target || row.label || '优化版',
    });
  }

  return entries.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getResumeEntry(
  db: SQLiteDatabase,
  kind: ResumeEntryKind,
  id: string,
): ResumeEntry | null {
  return listResumeEntries(db).find((e) => e.kind === kind && e.id === id) ?? null;
}

export interface ResumeEntryPatch {
  /** 只有母版可以改名 */
  label?: string;
  contentMd?: string;
  previewStyle?: string;
}

export async function updateResumeEntry(
  db: SQLiteDatabase,
  kind: ResumeEntryKind,
  id: string,
  patch: ResumeEntryPatch,
): Promise<void> {
  const identity = await getDeviceIdentity(db);
  const now = Date.now();

  writingAs(db, identity.deviceId, () => {
    if (kind === 'resume') {
      const sets: string[] = [];
      const args: Array<string | number> = [];
      if (patch.label !== undefined) {
        sets.push('label = ?');
        args.push(patch.label);
      }
      if (patch.contentMd !== undefined) {
        sets.push('raw_text = ?');
        args.push(patch.contentMd);
      }
      if (patch.previewStyle !== undefined) {
        sets.push('preview_style = ?');
        args.push(patch.previewStyle);
      }
      if (sets.length === 0) return;
      sets.push('updated_at = ?');
      args.push(now, id);
      db.runSync(`UPDATE resume SET ${sets.join(', ')} WHERE id = ?`, ...args);
      return;
    }

    const sets: string[] = [];
    const args: Array<string | number> = [];
    if (patch.contentMd !== undefined) {
      sets.push('content_md = ?', 'is_user_edited = 1');
      args.push(patch.contentMd);
    }
    if (patch.previewStyle !== undefined) {
      sets.push('preview_style = ?');
      args.push(patch.previewStyle);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    args.push(now, id);
    db.runSync(`UPDATE resume_variant SET ${sets.join(', ')} WHERE id = ?`, ...args);
  });
}

/** 粘贴进来的纯文本先按规则识别成固定模块，识别不了时原样保存 */
export async function createResumeFromText(
  db: SQLiteDatabase,
  label: string,
  rawText: string,
): Promise<Resume['id']> {
  const text = rawText.trim();
  if (!text) throw new Error('简历内容为空');

  const identity = await getDeviceIdentity(db);
  const id = Crypto.randomUUID();
  const now = Date.now();

  writingAs(db, identity.deviceId, () => {
    db.runSync(
      `INSERT INTO resume (id, label, raw_text, parsed, preview_style, created_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, ?, ?)`,
      id,
      label.trim() || '新建简历',
      structureResumeText(text),
      now,
      now,
    );
  });

  return id;
}

export async function deleteResumeEntry(
  db: SQLiteDatabase,
  kind: ResumeEntryKind,
  id: string,
): Promise<void> {
  const identity = await getDeviceIdentity(db);
  writingAs(db, identity.deviceId, () => {
    if (kind === 'resume') {
      db.runSync(`UPDATE campaign SET resume_id = NULL WHERE resume_id = ?`, id);
      db.runSync(`DELETE FROM resume_variant WHERE source_resume_id = ?`, id);
      db.runSync(`DELETE FROM resume WHERE id = ?`, id);
      return;
    }
    db.runSync(`DELETE FROM resume_variant WHERE id = ?`, id);
  });
}
