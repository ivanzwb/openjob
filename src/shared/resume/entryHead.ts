/**
 * 经历条目的表头约定：`### 机构 | 岗位 | 2021-04 ~ 至今`
 * 表单编辑与 HTML 渲染共用这里的解析/拼装，保证两端对同一份 markdown 的理解一致。
 */

export interface EntryHead {
  org: string;
  role: string;
  date: string;
}

/** 「2018-09 ~ 至今」「2020.06」「2016/09-2018/08」这类时间描述 */
export function looksLikeDate(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 32) return false;
  if (/[，。；;]/.test(t)) return false;
  const hasYear = /\d{4}/.test(t);
  const hasRange = /[~～至\-—–]|至今|now|present/i.test(t);
  if (hasYear && hasRange) return true;
  return /^\d{4}([.\-/年]\d{1,2}[月]?)?$/.test(t);
}

export function stripBullet(line: string): string {
  return line.trim().replace(/^[-*]\s+/, '');
}

export function parseEntryHead(raw: string): EntryHead {
  let text = raw.trim();
  let date = '';

  const trailingParen = text.match(/[（(]([^（()）]+)[)）]\s*$/);
  if (trailingParen && looksLikeDate(trailingParen[1])) {
    date = trailingParen[1].trim();
    text = text.slice(0, trailingParen.index).trim();
  }

  const segments = text
    .split(/\s*[|｜]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (!date) {
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      if (looksLikeDate(segments[i])) {
        date = segments[i];
        segments.splice(i, 1);
        break;
      }
    }
  }

  const org = segments.shift() ?? '';
  return { org, role: segments.join(' · '), date };
}

export function splitDateRange(date: string): { start: string; end: string } {
  // 「至」作为区间分隔符，但不能拆开「至今」
  const parts = date
    .split(/\s*[~～]\s*|\s+[-—–－]\s+|\s*至(?!今)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length >= 2) return { start: parts[0], end: parts.slice(1).join(' ') };
  // 「2016/09-2018/08」这类没有空格的连字符区间
  const month = String.raw`\d{4}[.\-/年]\d{1,2}[月]?`;
  const dashRange = date.match(
    new RegExp(String.raw`^(${month})\s*[-—–－]\s*(${month}|至今)$`),
  );
  if (dashRange) return { start: dashRange[1], end: dashRange[2] };
  return { start: date.trim(), end: '' };
}

export function joinDateRange(start: string, end: string): string {
  const s = start.trim();
  const e = end.trim();
  if (s && e) return `${s} ~ ${e}`;
  return s || e;
}

export function formatEntryHead(head: EntryHead): string {
  return [head.org.trim(), head.role.trim(), head.date.trim()].filter(Boolean).join(' | ');
}
