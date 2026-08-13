/**
 * 导入/粘贴进来的简历是没有结构的纯文本（PDF、Word、复制粘贴）。
 * 这里把它识别成 `## 模块` 的 markdown，让固定模块的表单能直接填上，
 * 而不是整份糊在「其他」里。识别全部是规则匹配，不联网、不调模型。
 */

import type { ResumeSectionKey } from './document';
import { catalogTitleForKey } from './document';

const HEADING_ALIASES: Array<{ pattern: RegExp; key: ResumeSectionKey }> = [
  { pattern: /^(基本信息|个人信息|个人资料|基本资料|个人档案|联系方式|profile|contact)$/i, key: 'basic' },
  {
    pattern: /^(求职意向|求职意愿|求职目标|职业意向|期望职位|期望岗位|意向岗位|objective)$/i,
    key: 'intention',
  },
  {
    pattern:
      /^(个人优势|个人总结|个人简介|个人评价|自我评价|自我描述|自我介绍|专业概述|职业概述|亮点|summary)$/i,
    key: 'summary',
  },
  {
    pattern:
      /^(工作经历|工作经验|工作履历|职业经历|从业经历|实习经历|实习经验|工作\/实习经历|工作及实习经历|(work)?experience)$/i,
    key: 'experience',
  },
  {
    pattern: /^(项目经历|项目经验|项目实践|项目介绍|主要项目|代表项目|projects?)$/i,
    key: 'project',
  },
  {
    pattern: /^(教育经历|教育背景|教育信息|学习经历|教育与培训|培训经历|education)$/i,
    key: 'education',
  },
  {
    pattern:
      /^(专业技能|技能专长|专业能力|专业技术|技术栈|技能清单|技能|IT技能|计算机技能|语言技能|skills?)$/i,
    key: 'skills',
  },
  {
    pattern:
      /^(资格证书|技能证书|荣誉证书|证书奖项|荣誉奖项|奖励荣誉|获奖情况|荣誉|证书|certificat(e|ions?))$/i,
    key: 'certificate',
  },
];

const ORDERED_KEYS: ResumeSectionKey[] = [
  'basic',
  'intention',
  'summary',
  'experience',
  'project',
  'education',
  'skills',
  'certificate',
  'other',
];

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;

/** 「138-0013-8000」「+86 13800138000」都归一成 11 位号码 */
function asPhone(text: string): string | null {
  const digits = text.replace(/[\s()（）\-‐‑–—.]/g, '').replace(/^\+?86/, '');
  return /^1[3-9]\d{9}$/.test(digits) ? digits : null;
}

/** 去掉装饰后判断这一行是不是模块标题 */
function headingKey(line: string): ResumeSectionKey | null {
  const text = line
    .replace(/[【】[\]（）()<>《》#*■◆●▍|｜]/g, ' ')
    .replace(/^[一二三四五六七八九十\d]+\s*[、.．)）]\s*/, '')
    .replace(/[-—–_=~\s]+$/, '')
    .replace(/\s+/g, '')
    .trim();
  if (!text || text.length > 14) return null;
  // 「姓名：张三」这类是内容，不是标题
  if (/[：:。，,；;]/.test(text)) return null;
  return HEADING_ALIASES.find((a) => a.pattern.test(text))?.key ?? null;
}

function normalizeBullet(line: string): string {
  return line.replace(/^[•·▪▫◦●○★☆✓✔＊+]\s*/, '- ').replace(/^[*]\s+/, '- ');
}

/** 抬头区常见的一行多项：「138xxxxxxxx | a@b.com | 上海」 */
function labelContactToken(token: string): string | null {
  const text = token.trim();
  if (!text) return null;
  if (/[：:]/.test(text)) return text;
  if (EMAIL.test(text)) return `邮箱：${text.match(EMAIL)?.[0] ?? text}`;
  const phone = asPhone(text);
  if (phone) return `电话：${phone}`;
  if (/^(男|女)$/.test(text)) return `性别：${text}`;
  if (/^\d{2}\s*岁$/.test(text)) return `年龄：${text}`;
  if (/^\d+\s*年(工作)?经验$/.test(text)) return `工作年限：${text.replace(/经验$/, '')}`;
  if (/^(本科|硕士|博士|大专|专科|研究生|MBA)$/i.test(text)) return `学历：${text}`;
  if (/^[\u4e00-\u9fa5]{2,4}(市|省)?$/.test(text)) return `城市：${text}`;
  return text;
}

/**
 * 第一个模块标题之前的内容是抬头区：姓名 + 联系方式。
 * 姓名取第一行的短名字，其余按符号拆成「标签：值」，认不出的整句丢给「其他」。
 */
function structureHeadBlock(lines: string[]): { basic: string[]; other: string[] } {
  const basic: string[] = [];
  const other: string[] = [];
  let nameTaken = false;

  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;

    if (!nameTaken && !/[：:]/.test(text) && /^[\u4e00-\u9fa5]{2,4}$/.test(text)) {
      basic.push(`姓名：${text}`);
      nameTaken = true;
      continue;
    }
    if (/^姓\s*名\s*[：:]/.test(text)) nameTaken = true;

    const tokens = text.split(/\s*[|｜/、,，]\s*|\s{2,}|\s+(?=[\w.+-]+@)/).filter(Boolean);
    // 整句叙述留给「其他」，避免把一段话塞进信息表
    if (tokens.length === 1 && text.length > 24 && !/[：:]/.test(text) && !EMAIL.test(text)) {
      other.push(text);
      continue;
    }
    for (const token of tokens) {
      const labeled = labelContactToken(token);
      if (labeled) basic.push(labeled);
    }
  }

  return { basic, other };
}

/** 已经是 `## 模块` 结构的文本原样返回 */
export function isStructuredResumeMarkdown(text: string): boolean {
  return /^##\s+\S/m.test(text);
}

export function structureResumeText(raw: string): string {
  const text = raw.replace(/\r\n?/g, '\n').trim();
  if (!text) return '';
  if (isStructuredResumeMarkdown(text)) return text;

  const buckets = new Map<ResumeSectionKey, string[]>();
  const append = (key: ResumeSectionKey, lines: string[]): void => {
    if (lines.length === 0) return;
    const existing = buckets.get(key);
    if (existing) existing.push(...lines);
    else buckets.set(key, [...lines]);
  };

  const headLines: string[] = [];
  let currentKey: ResumeSectionKey | null = null;
  let currentLines: string[] = [];

  const flush = (): void => {
    if (currentKey) append(currentKey, currentLines);
    currentLines = [];
  };

  for (const line of text.split('\n')) {
    const key = headingKey(line);
    if (key) {
      flush();
      currentKey = key;
      continue;
    }
    if (!currentKey) {
      headLines.push(line);
      continue;
    }
    currentLines.push(normalizeBullet(line.trim()));
  }
  flush();

  const head = structureHeadBlock(headLines);
  // 抬头识别出的字段排在正文里的「基本信息」之前
  if (head.basic.length > 0) {
    buckets.set('basic', [...head.basic, ...(buckets.get('basic') ?? [])]);
  }
  append('other', head.other);

  const blocks: string[] = [];
  for (const key of ORDERED_KEYS) {
    const body = (buckets.get(key) ?? []).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!body) continue;
    blocks.push(`## ${catalogTitleForKey(key)}\n\n${body}`);
  }
  // 一个模块标题都没认出来时，别丢内容，整份进「其他」
  if (blocks.length === 0) return text;
  return blocks.join('\n\n');
}
