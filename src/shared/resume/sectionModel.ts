/**
 * 各模块的结构化编辑模型。
 *
 * 存储层始终是 markdown（resume_variant.content_md），这里负责 markdown 与表单结构之间的
 * 双向转换，让每个模块可以用合适的表单编辑，同时不改变数据库、LLM 与 PDF 渲染的契约。
 */

import type { ResumeSectionKey } from './document';
import {
  joinDateRange,
  looksLikeDate,
  parseEntryHead,
  splitDateRange,
  stripBullet,
} from './entryHead';

export type SectionFormKind = 'fields' | 'bullets' | 'entries' | 'text';

const FORM_KIND: Record<ResumeSectionKey, SectionFormKind> = {
  basic: 'fields',
  intention: 'fields',
  summary: 'bullets',
  experience: 'entries',
  project: 'entries',
  education: 'entries',
  skills: 'bullets',
  certificate: 'bullets',
  other: 'text',
};

export function formKindForSection(key: ResumeSectionKey): SectionFormKind {
  return FORM_KIND[key] ?? 'text';
}

/** 表单里固定展示的字段行；留空的行不会写入 markdown。 */
const PRESET_FIELDS: Partial<Record<ResumeSectionKey, string[]>> = {
  // 姓名与求职岗位排在最前：渲染时它们会成为简历的标题与副标题
  basic: ['姓名', '求职岗位', '性别', '年龄', '城市', '工作年限', '电话', '邮箱'],
  intention: ['期望岗位', '期望城市', '期望薪资', '到岗时间'],
};

export function presetFieldsForSection(key: ResumeSectionKey): string[] {
  return PRESET_FIELDS[key] ?? [];
}

export interface SectionField {
  label: string;
  value: string;
}

export interface SectionEntry {
  org: string;
  role: string;
  start: string;
  end: string;
  description: string;
  bullets: string[];
}

export interface EntriesSectionData {
  lead: string;
  entries: SectionEntry[];
}

function normalizeLabel(label: string): string {
  return label.replace(/\s+/g, '');
}

function splitLines(md: string): string[] {
  return md.split('\n');
}

export function parseFieldsSection(md: string, key: ResumeSectionKey): SectionField[] {
  const parsed: SectionField[] = splitLines(md)
    .map((line) => stripBullet(line))
    .filter(Boolean)
    .map((line) => {
      const kv = line.match(/^(.{1,14}?)\s*[：:]\s*(.+)$/);
      return kv
        ? { label: normalizeLabel(kv[1]), value: kv[2].trim() }
        : { label: '', value: line };
    });

  const presets = presetFieldsForSection(key);
  const rows: SectionField[] = presets.map((label) => ({
    label,
    value: parsed.find((p) => p.label === label)?.value ?? '',
  }));
  for (const field of parsed) {
    if (!presets.includes(field.label)) rows.push(field);
  }
  return rows;
}

export function serializeFieldsSection(rows: SectionField[]): string {
  return rows
    .filter((row) => row.value.trim())
    .map((row) => {
      const label = row.label.trim();
      return label ? `- ${label}：${row.value.trim()}` : `- ${row.value.trim()}`;
    })
    .join('\n');
}

export function parseBulletsSection(md: string): string[] {
  return splitLines(md)
    .map((line) => stripBullet(line))
    .filter(Boolean);
}

export function serializeBulletsSection(items: string[]): string {
  return items
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => `- ${item}`)
    .join('\n');
}

export function createEmptyEntry(): SectionEntry {
  return { org: '', role: '', start: '', end: '', description: '', bullets: [''] };
}

export function parseEntriesSection(md: string): EntriesSectionData {
  const lines = splitLines(md);
  const leadLines: string[] = [];
  const entries: SectionEntry[] = [];
  let current: SectionEntry | null = null;
  const descriptionLines: string[][] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i].trim();

    if (/^#{3,}\s+/.test(text)) {
      const head = parseEntryHead(text.replace(/^#+\s*/, ''));
      if (!head.date) {
        const next = lines[i + 1] ? stripBullet(lines[i + 1]) : '';
        if (next && looksLikeDate(next)) {
          head.date = next;
          i += 1;
        }
      }
      const range = splitDateRange(head.date);
      current = {
        org: head.org,
        role: head.role,
        start: range.start,
        end: range.end,
        description: '',
        bullets: [],
      };
      entries.push(current);
      descriptionLines.push([]);
      continue;
    }

    if (!text) continue;

    if (!current) {
      leadLines.push(text);
      continue;
    }

    if (/^[-*]\s+/.test(lines[i].trim())) {
      current.bullets.push(stripBullet(text));
      continue;
    }
    descriptionLines[entries.length - 1].push(text);
  }

  entries.forEach((entry, index) => {
    entry.description = descriptionLines[index].join('\n');
  });

  return { lead: leadLines.join('\n'), entries };
}

export function serializeEntriesSection(data: EntriesSectionData): string {
  const blocks: string[] = [];
  const lead = data.lead.trim();
  if (lead) blocks.push(lead);

  for (const entry of data.entries) {
    const headText = [
      entry.org.trim(),
      entry.role.trim(),
      joinDateRange(entry.start, entry.end),
    ]
      .filter(Boolean)
      .join(' | ');
    const bullets = entry.bullets
      .map((b) => b.trim())
      .filter(Boolean)
      .map((b) => `- ${b}`);
    const description = entry.description.trim();
    if (!headText && !description && bullets.length === 0) continue;

    const parts = [headText ? `### ${headText}` : ''];
    if (description) parts.push(description);
    if (bullets.length) parts.push(bullets.join('\n'));
    blocks.push(parts.filter(Boolean).join('\n\n'));
  }

  return blocks.join('\n\n');
}
