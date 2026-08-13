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

const MONTH = String.raw`(?:19|20)\d{2}(?:\s*[.\-/年]\s*\d{1,2}\s*[月]?)?`;
/** 行尾的时间：「2021-04 ~ 至今」「（2016/09-2018/08）」「2020.06」 */
const DATE_TAIL = new RegExp(
  String.raw`[（(]?\s*(${MONTH}(?:\s*[~～至\-—–－]\s*(?:${MONTH}|至今|now|present))?)\s*[)）]?\s*$`,
  'i',
);

/**
 * 判断一行是不是经历条目的表头。`### ` 之外也认这两种写法，
 * 否则 LLM 或导入的简历没写 `###` 时，内容就填不进条目表单、也排不出右对齐时间。
 */
export function looksLikeEntryHead(line: string): boolean {
  const text = line.trim().replace(/\*\*/g, '');
  if (!text || text.length > 60) return false;
  if (/^[-*#]/.test(text)) return false;
  // 句子和「标签：值」都不是表头
  if (/[。；;，：:]/.test(text)) return false;
  if (/[|｜]/.test(text)) return true;
  if (findParenDate(text)) return true;
  // 时间必须在行尾、前面还有机构名，否则「2021 年拿到 X 奖」这类正文会被误判
  return Boolean(splitHeadDateTail(text));
}

/** 整段就是时间，如「2021-04 ~ 至今」 */
const DATE_ONLY = new RegExp(
  String.raw`^${MONTH}(?:\s*[~～至\-—–－]\s*(?:${MONTH}|至今|now|present))?$`,
  'i',
);

/** 括号里的时间，返回它在原串中的位置以便剔除 */
function findParenDate(text: string): { date: string; start: number; end: number } | null {
  for (const match of text.matchAll(/[（(]([^（()）]+)[)）]/g)) {
    if (match.index !== undefined && looksLikeDate(match[1])) {
      return { date: match[1].trim(), start: match.index, end: match.index + match[0].length };
    }
  }
  return null;
}

/** 无分隔符表头的时间在行尾时，切出「前半 + 时间」 */
function splitHeadDateTail(text: string): { rest: string; date: string } | null {
  const tail = text.match(DATE_TAIL);
  if (!tail?.index) return null;
  const rest = text.slice(0, tail.index).trim();
  // 前面紧跟数字说明是长串数字的一部分，例如电话号码
  if (!rest || /\d$/.test(rest)) return null;
  return { rest, date: tail[1].trim() };
}

export function parseEntryHead(raw: string): EntryHead {
  let text = raw.trim().replace(/\*\*/g, '');
  let date = '';

  // 括号里的时间可能不在行尾，如「字节跳动（2018/07-2021/03） 前端工程师」
  const paren = findParenDate(text);
  if (paren) {
    date = paren.date;
    text = `${text.slice(0, paren.start)}  ${text.slice(paren.end)}`.trim();
  }

  const separated = /[|｜]/.test(text);
  const segments = text
    .split(/\s*[|｜]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (!date) {
    // 只有整段就是时间的分段才算时间，否则没有分隔符时会把整行都当成时间
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      if (DATE_ONLY.test(segments[i])) {
        date = segments[i];
        segments.splice(i, 1);
        break;
      }
    }
  }

  // 没有分隔符的表头，如「腾讯科技 前端工程师 2021-04 ~ 至今」
  if (!date && segments.length > 0) {
    const split = splitHeadDateTail(segments[segments.length - 1]);
    if (split) {
      date = split.date;
      segments[segments.length - 1] = split.rest;
    }
  }

  let org = segments.shift() ?? '';
  let role = segments.join(' · ');

  // 没有分隔符时靠空格拆机构与岗位：优先多空格，其次中文机构名后的第一处空格
  if (!separated && !role) {
    const split =
      org.match(/^(.+?)\s{2,}(.+)$/) ??
      org.match(/^([\u4e00-\u9fa5（）()·]{2,14})\s+(.+)$/) ??
      org.match(/^(\S+)\s(\S+)$/);
    if (split) {
      org = split[1].trim();
      role = split[2].trim();
    }
  }

  return { org, role, date };
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
