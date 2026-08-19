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
  // 姓名排在最前：渲染时它会成为简历的标题；岗位信息统一填在「求职意向」
  basic: ['姓名', '性别', '年龄', '城市', '工作年限', '电话', '邮箱'],
  intention: ['期望岗位', '期望城市', '期望薪资', '到岗时间'],
};

export function presetFieldsForSection(key: ResumeSectionKey): string[] {
  return PRESET_FIELDS[key] ?? [];
}

export type FieldControl = 'text' | 'select' | 'number' | 'tel' | 'email';

/**
 * 字段该用什么控件。取值范围明确的字段（性别、学历）给选择器，带单位的给数字框，
 * 免得同一个字段在不同简历里出现「男 / 男性」「28 岁 / 28岁 / 二十八」这类写法。
 */
export interface FieldSpec {
  control: FieldControl;
  /** select 的候选项 */
  options?: readonly string[];
  /** 候选项之外还能自己写（学历、到岗时间的说法太多，不能锁死） */
  allowCustom?: boolean;
  /** number 的单位：表单只填数字，落库时补上，如 `- 年龄：28 岁` */
  unit?: string;
  min?: number;
  max?: number;
  placeholder?: string;
}

const TEXT_FIELD: FieldSpec = { control: 'text' };

const FIELD_SPECS: Record<string, FieldSpec> = {
  姓名: { control: 'text', placeholder: '张三' },
  求职岗位: { control: 'text', placeholder: '高级前端工程师' },
  性别: { control: 'select', options: ['男', '女'] },
  年龄: { control: 'number', unit: '岁', min: 16, max: 70, placeholder: '28' },
  城市: { control: 'text', placeholder: '上海' },
  工作年限: { control: 'number', unit: '年', min: 0, max: 45, placeholder: '5' },
  电话: { control: 'tel', placeholder: '13800000000' },
  邮箱: { control: 'email', placeholder: 'name@example.com' },
  学历: {
    control: 'select',
    options: ['高中及以下', '中专', '大专', '本科', '硕士', '博士'],
    allowCustom: true,
  },
  政治面貌: {
    control: 'select',
    options: ['群众', '共青团员', '中共预备党员', '中共党员'],
    allowCustom: true,
  },
  婚姻状况: { control: 'select', options: ['未婚', '已婚'] },
  期望岗位: { control: 'text', placeholder: '高级前端工程师' },
  期望城市: { control: 'text', placeholder: '上海' },
  // 期望薪资写法太多（25-35K / 30 万年包 / 面议），给不出候选项，保持自由填写
  期望薪资: { control: 'text', placeholder: '25-35K' },
  到岗时间: {
    control: 'select',
    options: ['随时到岗', '一周内', '两周内', '一个月内', '两个月内', '三个月内'],
    allowCustom: true,
  },
};

/** 自定义字段（用户自己加的行）一律纯文本 */
export function fieldSpecFor(label: string): FieldSpec {
  return FIELD_SPECS[normalizeLabel(label)] ?? TEXT_FIELD;
}

/**
 * 从带单位的值里取出数字部分供数字框显示。
 * 取不出来（导入来的「二十八岁」「5 年工作」）返回 null，调用方退回纯文本框，
 * 宁可少一个选择器也不能把用户已有的内容吃掉。
 */
export function parseUnitNumber(value: string, unit: string): string | null {
  const text = value.trim();
  if (!text) return '';
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(.*)$/);
  if (!match) return null;
  const [, num, tail] = match;
  return !tail || tail === unit ? num : null;
}

/** 数字框写回 markdown：补上单位，空值仍然是空（留空的字段不进 PDF） */
export function formatUnitNumber(num: string, unit: string): string {
  const text = num.trim();
  return text ? `${text} ${unit}` : '';
}

/**
 * 经历时间给月份选择器用：`2021-04`、`2021.4`、`2021/4`、`2021年4月` 都能进，
 * 统一按 `YYYY-MM` 输出。认不出来（`2021`、`至今`、空）返回 null，调用方退回纯文本框。
 */
export function toMonthInputValue(value: string): string | null {
  const match = value.trim().match(/^((?:19|20)\d{2})\s*[.\-/年]\s*(\d{1,2})\s*月?$/);
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return `${match[1]}-${String(month).padStart(2, '0')}`;
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

/** 条目换位。目标越界就原样返回，调用方据此禁用按钮 */
export function moveInList<T>(list: T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
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
