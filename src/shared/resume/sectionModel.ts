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
  looksLikeEntryHead,
  parseEntryHead,
  splitDateRange,
  stripBullet,
} from './entryHead';

export type SectionFormKind = 'fields' | 'bullets' | 'entries' | 'text';

const FORM_KIND: Record<ResumeSectionKey, SectionFormKind> = {
  basic: 'fields',
  intention: 'fields',
  summary: 'text',
  experience: 'entries',
  project: 'entries',
  education: 'entries',
  skills: 'text',
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
  /** 职责与成果：原样保存用户写的多行文本（`- ` 开头即为分条） */
  description: string;
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
  return { org: '', role: '', start: '', end: '', description: '' };
}

/**
 * 所有内容都落进条目字段：`### ` 之外也认「机构 | 岗位 | 时间」和以时间结尾的表头，
 * 表头之外的内容原样进描述，格式（分条、分段）由用户自己掌握。
 */
export function parseEntriesSection(md: string): SectionEntry[] {
  const lines = splitLines(md);
  const entries: SectionEntry[] = [];

  const openEntry = (head: { org: string; role: string; date: string }): SectionEntry => {
    const range = splitDateRange(head.date);
    const entry: SectionEntry = {
      org: head.org,
      role: head.role,
      start: range.start,
      end: range.end,
      description: '',
    };
    entries.push(entry);
    return entry;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i].trim();

    const headText = !text
      ? null
      : /^#{3,}\s+/.test(text)
        ? text.replace(/^#+\s*/, '')
        : looksLikeEntryHead(text)
          ? text
          : null;

    if (headText !== null) {
      const head = parseEntryHead(headText);
      if (!head.date) {
        // 时间单独占一行的写法
        const next = lines[i + 1] ? stripBullet(lines[i + 1]) : '';
        if (next && looksLikeDate(next)) {
          head.date = next;
          i += 1;
        }
      }
      openEntry(head);
      continue;
    }

    const current = entries[entries.length - 1] ?? null;
    // 条目还没开始前的空行忽略，条目内的空行保留，用户的分段不被吃掉
    if (!text && (!current || !current.description)) continue;

    const target = current ?? openEntry({ org: '', role: '', date: '' });
    target.description = target.description ? `${target.description}\n${text}` : text;
  }

  for (const entry of entries) {
    entry.description = entry.description.trim();
  }

  return entries;
}

export function serializeEntriesSection(entries: SectionEntry[]): string {
  const blocks: string[] = [];

  for (const entry of entries) {
    const headText = [
      entry.org.trim(),
      entry.role.trim(),
      joinDateRange(entry.start, entry.end),
    ]
      .filter(Boolean)
      .join(' | ');
    const description = entry.description.trim();
    if (!headText && !description) continue;

    const parts = [headText ? `### ${headText}` : ''];
    if (description) parts.push(description);
    blocks.push(parts.filter(Boolean).join('\n\n'));
  }

  return blocks.join('\n\n');
}
