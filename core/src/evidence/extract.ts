/**
 * 从候选人自述文档里抽取证据候选。
 *
 * 这里是规则抽取而不是模型抽取，原因不是省钱：每条证据都要带一个能回指原文的
 * 字符区间，而模型给的区间是它「记得的」区间，对不上就得整条丢掉。规则扫描是
 * 一边走文本一边记偏移，区间天然准确，同一份简历每次抽出来也完全一样——用户
 * 确认过的东西不会因为重跑一次抽取就变成另一条。
 *
 * 模型的位置在这之后：把抽出来的 statement 改写得更像人话是安全的，改写来源
 * 区间不是。
 */

import { inferSectionKey, type ResumeSectionKey } from '../resume/document';
import { parseEntryHead, stripBullet } from '../resume/entryHead';
import type { CandidateEvidenceKind } from '../enums';
import type { CandidateDocument, EvidenceExtractionInput, EvidenceProposal } from './types';

/** 带量化结果的句子才算 achievement，否则「负责若干模块」也会被当成成果 */
const QUANTIFIED =
  /\d+(?:\.\d+)?\s*[%％]|\d+(?:\.\d+)?\s*(?:倍|万|亿|ms|qps|tps|人|次|天|小时|分钟)|\d{2,}/i;

/** 技能行里的分隔符。冒号左边是类别，右边才是一项项技能 */
const SKILL_SPLIT = /[、,，;；/|]/;

const SKILL_CATEGORY = /^(.{1,12}?)\s*[：:]\s*(.+)$/;

interface Line {
  text: string;
  /** 相对文档全文的起始偏移 */
  offset: number;
}

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let offset = 0;
  for (const raw of text.split('\n')) {
    lines.push({ text: raw, offset });
    offset += raw.length + 1;
  }
  return lines;
}

/** 去掉行首缩进和 markdown 项目符号之后，这一行在原文里的起点 */
function contentStart(line: Line): number {
  const stripped = stripBullet(line.text);
  if (!stripped) return line.offset;
  return line.offset + line.text.indexOf(stripped);
}

interface Emit {
  kind: CandidateEvidenceKind;
  title: string;
  statement: string;
  quote: string;
  start: number;
  occurredAt: string | null;
  confidence: number;
}

/**
 * 表头里的时间归一成 `YYYY-MM`。
 *
 * 取不到就是 null，不去猜：一条写着「2021 年」的经历被补成 `2021-01`，之后
 * 任何按时间排序的界面都会显示一个用户从没写过的月份。
 */
function normalizeOccurredAt(date: string): string | null {
  const match = date.match(/((?:19|20)\d{2})\s*[.\-/年]\s*(\d{1,2})/);
  if (match) {
    const month = Number(match[2]);
    if (month >= 1 && month <= 12) return `${match[1]}-${String(month).padStart(2, '0')}`;
  }
  const year = date.match(/^\s*((?:19|20)\d{2})\s*年?\s*$/);
  return year ? year[1] : null;
}

function entryProposal(line: Line, headText: string): Emit {
  const head = parseEntryHead(headText);
  const label = [head.org, head.role].filter(Boolean).join(' · ') || headText.trim();
  return {
    kind: 'experience',
    title: label,
    statement: head.role && head.org ? `在${head.org}担任${head.role}` : label,
    quote: headText,
    start: line.offset + line.text.indexOf(headText),
    occurredAt: normalizeOccurredAt(head.date),
    confidence: 0.9,
  };
}

function skillProposals(body: string, bodyStart: number, category: string): Emit[] {
  const out: Emit[] = [];
  let cursor = 0;
  for (const raw of body.split(SKILL_SPLIT)) {
    const found = body.indexOf(raw, cursor);
    cursor = found + raw.length;
    const name = raw.trim();
    if (!name) continue;
    // 每项技能单独定位：整行一条的话，用户点开只能看到「前端：五个框架」，
    // 而 T11 的能力映射要的是「React 这一项写在简历哪里」
    out.push({
      kind: 'skill',
      title: name,
      statement: category ? `${category}：${name}` : name,
      quote: name,
      start: bodyStart + found + raw.indexOf(name),
      occurredAt: null,
      confidence: 0.7,
    });
  }
  return out.length > 0
    ? out
    : [
        {
          kind: 'skill',
          title: body.trim(),
          statement: body.trim(),
          quote: body.trim(),
          start: bodyStart,
          occurredAt: null,
          confidence: 0.7,
        },
      ];
}

function bulletProposal(
  line: Line,
  kind: CandidateEvidenceKind,
  confidence: number,
): Emit | null {
  const content = stripBullet(line.text);
  if (!content) return null;
  return {
    kind,
    title: content.length > 24 ? `${content.slice(0, 24)}…` : content,
    statement: content,
    quote: content,
    start: contentStart(line),
    occurredAt: null,
    confidence,
  };
}

function scanResume(document: CandidateDocument): Emit[] {
  const out: Emit[] = [];
  let section: ResumeSectionKey = 'other';

  for (const line of splitLines(document.text)) {
    const text = line.text.trim();
    if (!text) continue;

    const heading = text.match(/^##\s+(.*)$/);
    if (heading) {
      section = inferSectionKey(heading[1]);
      continue;
    }

    const entryHead = text.match(/^#{3,}\s+(.*)$/);
    if (entryHead) {
      if (section === 'experience' || section === 'project') {
        out.push(entryProposal(line, entryHead[1].trim()));
      } else if (section === 'education') {
        const head = parseEntryHead(entryHead[1].trim());
        out.push({
          kind: 'credential',
          title: [head.org, head.role].filter(Boolean).join(' · '),
          statement: entryHead[1].trim(),
          quote: entryHead[1].trim(),
          start: line.offset + line.text.indexOf(entryHead[1].trim()),
          occurredAt: normalizeOccurredAt(head.date),
          confidence: 0.8,
        });
      }
      continue;
    }

    if (section === 'skills') {
      const content = stripBullet(line.text);
      if (!content) continue;
      const start = contentStart(line);
      const categorized = content.match(SKILL_CATEGORY);
      if (categorized) {
        const body = categorized[2];
        out.push(...skillProposals(body, start + content.indexOf(body), categorized[1].trim()));
      } else {
        out.push(...skillProposals(content, start, ''));
      }
      continue;
    }

    if (section === 'certificate') {
      const proposal = bulletProposal(line, 'credential', 0.8);
      if (proposal) out.push(proposal);
      continue;
    }

    // 职责描述里只有带量化结果的那几条算得上成果；「负责 X 模块」不是成果，
    // 收进来只会让确认列表长到没人看
    if (
      (section === 'experience' || section === 'project' || section === 'summary') &&
      QUANTIFIED.test(text)
    ) {
      const proposal = bulletProposal(line, 'achievement', 0.8);
      if (proposal) out.push(proposal);
    }
  }

  return out;
}

/** 面后复盘是自由文本，没有结构可依，逐条分行取「我当时怎么答的」 */
function scanSelfReport(document: CandidateDocument): Emit[] {
  const out: Emit[] = [];
  for (const line of splitLines(document.text)) {
    if (!line.text.trim()) continue;
    const proposal = bulletProposal(line, 'behavior', 0.5);
    if (proposal) out.push(proposal);
  }
  return out;
}

/**
 * 岗位上下文里的名词。
 *
 * 只用来给候选人事实排序——命中越多排越前。抽出来的词绝不会进 statement 或
 * quote：那正是「JD 变成经历」的形态。
 */
function jobContextTerms(input: EvidenceExtractionInput): string[] {
  const terms = new Set<string>();
  for (const document of input.jobContext ?? []) {
    for (const token of document.text.split(/[^0-9A-Za-z\u4e00-\u9fa5+#.]+/)) {
      if (token.length >= 2) terms.add(token.toLowerCase());
    }
  }
  return [...terms];
}

function relevance(quote: string, terms: readonly string[]): number {
  const lower = quote.toLowerCase();
  return terms.reduce((count, term) => (lower.includes(term) ? count + 1 : count), 0);
}

/**
 * 抽取候选证据。
 *
 * 只接受 CandidateDocument：JD 与公司情报走 `jobContext`，进不了这条链路。
 * 结果按「岗位相关度 → 文档顺序 → 原文位置」排序，同一份输入永远得到同一个
 * 顺序，界面上的确认列表才不会每次刷新都换一遍位置。
 */
export function extractEvidenceProposals(
  input: EvidenceExtractionInput,
): EvidenceProposal[] {
  const terms = jobContextTerms(input);
  const rows: Array<{ proposal: EvidenceProposal; score: number; order: number; start: number }> =
    [];

  input.documents.forEach((document, order) => {
    const emits =
      document.kind === 'selfReport' ? scanSelfReport(document) : scanResume(document);
    for (const emit of emits) {
      // 偏移是扫描时算出来的，但仍然按最终区间回读一次：拿不回原文的条目
      // 一律不产出，让「可定位原文」在抽取端就成立，而不是等落库时才被拒
      const end = emit.start + emit.quote.length;
      if (document.text.slice(emit.start, end) !== emit.quote) continue;
      rows.push({
        proposal: {
          campaignId: input.campaignId,
          kind: emit.kind,
          title: emit.title,
          statement: emit.statement,
          source: {
            kind: document.kind,
            documentId: document.id,
            start: emit.start,
            end,
            quote: emit.quote,
          },
          occurredAt: emit.occurredAt,
          confidence: emit.confidence,
        },
        score: relevance(emit.quote, terms),
        order,
        start: emit.start,
      });
    }
  });

  return rows
    .sort(
      (left, right) =>
        right.score - left.score || left.order - right.order || left.start - right.start,
    )
    .map((row) => row.proposal);
}
