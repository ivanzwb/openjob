/**
 * 从简历 markdown 里抽出带时间的工作/项目经历，按时间倒序排。
 *
 * 为什么不能用 `resume.parsed`：那份结构（`ResumeParsed.projects`）只有名称、
 * 一句话摘要和可深挖点，既没有时间也没有顺序，取前四条等于随机取四条。模拟
 * 面试的参考答案要"最近的经历优先"，靠它根本判断不出哪段是最近的。
 *
 * 带时间的经历一直都在 `resume.rawText` 的 markdown 里（`### 机构 | 岗位 |
 * 2021-04 ~ 至今`），只是没人把它读出来——这里复用简历编辑器那套解析，不另起
 * 一套格式约定。
 */

import { parseMarkdownToDocument } from './document';
import { parseEntriesSection } from './sectionModel';

export interface ResumeExperienceEntry {
  /** 来自「工作经历」还是「项目经历」 */
  section: 'experience' | 'project';
  org: string;
  role: string;
  /** 原样保留用户写法，如 `2021-04 ~ 至今`；没写时为空串 */
  period: string;
  /** 结束时间是「至今」这类，说明还在进行中 */
  ongoing: boolean;
  description: string;
}

const ONGOING = /^(至今|今|现在|目前|now|present|current)$/i;

/**
 * 转成可比较的 `YYYYMM`。只写了年份时按 fallbackMonth 补：起始补 01、结束补 12,
 * 这样「2021」当结束时间排在「2021-06」后面，符合"整个 2021 年都在"的读法。
 */
function monthKey(text: string, fallbackMonth: 1 | 12): number | null {
  const t = text.trim();
  if (!t) return null;

  const withMonth = t.match(/^((?:19|20)\d{2})\s*[.\-/年]\s*(\d{1,2})\s*月?$/);
  if (withMonth) {
    const month = Number(withMonth[2]);
    if (month >= 1 && month <= 12) return Number(withMonth[1]) * 100 + month;
    return null;
  }

  const yearOnly = t.match(/^((?:19|20)\d{2})\s*年?$/);
  if (yearOnly) return Number(yearOnly[1]) * 100 + fallbackMonth;

  return null;
}

/** 排序用的结束时间。进行中的排最前，认不出时间的排最后 */
function endRank(entry: { end: string; start: string }): number {
  if (ONGOING.test(entry.end.trim())) return Number.MAX_SAFE_INTEGER;
  return monthKey(entry.end, 12) ?? monthKey(entry.start, 12) ?? -1;
}

function startRank(entry: { start: string }): number {
  return monthKey(entry.start, 1) ?? -1;
}

function joinPeriod(start: string, end: string): string {
  const s = start.trim();
  const e = end.trim();
  if (s && e) return `${s} ~ ${e}`;
  return s || e;
}

/**
 * 按时间倒序的经历列表：进行中的在最前，其次按结束时间从新到旧，
 * 结束时间相同再看开始时间。完全没写时间的排在最后——判断不出新旧的经历
 * 不该冒充最近的。
 */
export function buildResumeExperienceTimeline(resumeMd: string): ResumeExperienceEntry[] {
  const doc = parseMarkdownToDocument(resumeMd ?? '');
  const ranked: Array<{ entry: ResumeExperienceEntry; end: number; start: number }> = [];

  for (const key of ['experience', 'project'] as const) {
    const section = doc.sections.find((s) => s.key === key);
    if (!section?.contentMd.trim()) continue;

    for (const raw of parseEntriesSection(section.contentMd)) {
      if (!raw.org.trim() && !raw.role.trim() && !raw.description.trim()) continue;
      ranked.push({
        entry: {
          section: key,
          org: raw.org.trim(),
          role: raw.role.trim(),
          period: joinPeriod(raw.start, raw.end),
          ongoing: ONGOING.test(raw.end.trim()),
          description: raw.description.trim(),
        },
        end: endRank(raw),
        start: startRank(raw),
      });
    }
  }

  return ranked.sort((a, b) => b.end - a.end || b.start - a.start).map((r) => r.entry);
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

export interface ExperiencePromptOptions {
  maxEntries?: number;
  maxDescriptionChars?: number;
}

/**
 * 拼进面试上下文的经历块。
 *
 * 开头那句「按时间倒序」不是排版说明，是给模型的取材依据：只丢一串经历过去，
 * 它会挑描述最丰满的那段来答，而那段常常是三四年前的项目——面试官问的是你
 * 现在什么水平。序号和「进行中」标记都是为了让"哪段最近"没有歧义。
 *
 * 一段带不出时间的简历（纯文本导入、还没结构化）返回空串，调用方退回原来的
 * 项目摘要：给不出时间就别假装有顺序。
 */
export function formatResumeExperienceForPrompt(
  resumeMd: string,
  options: ExperiencePromptOptions = {},
): string {
  const { maxEntries = 6, maxDescriptionChars = 400 } = options;
  const entries = buildResumeExperienceTimeline(resumeMd);
  if (!entries.some((e) => e.period)) return '';

  const lines = entries.slice(0, maxEntries).map((entry, i) => {
    const who = [entry.org, entry.role].filter(Boolean).join(' · ');
    const tag = entry.section === 'project' ? '项目' : '工作';
    const head = [
      `${i + 1}. [${tag}${entry.ongoing ? '·进行中' : ''}]`,
      entry.period || '（时间未写）',
      who,
    ]
      .filter(Boolean)
      .join(' ');
    const body = entry.description ? `\n${truncate(entry.description, maxDescriptionChars)}` : '';
    return `${head}${body}`;
  });

  return `简历经历（按时间倒序，序号越小越近；作答优先取靠前的）：
${lines.join('\n\n')}`;
}

/** `ResumeParsed.projects` 的最小形状；手机端是自己 JSON.parse 出来的，不共用实体类型 */
export interface FallbackProject {
  name: string;
  summary: string;
  drillableTopics: string[];
}

/**
 * 面试上下文里的经历段落，两端共用。
 *
 * 优先用 rawText 里带时间的经历；简历还没结构化（纯文本导入、一行时间都没有）
 * 时退回原来那份无序的项目摘要——给不出时间就别假装有顺序，但也不能因此把
 * 简历内容整个丢掉。
 */
export function resumeExperienceBlock(
  resumeMd: string,
  fallbackProjects?: FallbackProject[] | null,
  options: ExperiencePromptOptions = {},
): string {
  const timeline = formatResumeExperienceForPrompt(resumeMd, options);
  if (timeline) return timeline;

  const summary = (fallbackProjects ?? [])
    .slice(0, 4)
    .map((p) => `${p.name}：${p.summary}；可深挖：${p.drillableTopics.slice(0, 4).join('、')}`)
    .join('\n');

  return `简历项目（简历未填写时间，无法判断新旧）：\n${summary || '（未提供）'}`;
}
