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

import { catalogTitleForKey, parseMarkdownToDocument } from './document';
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

const SELF_INTRO_FACTS_HEADER =
  '【自我介绍唯一事实来源：仅限以下简历原文。公司情报、JD、面经不得当作候选人做过的事写进答案。】';

/** 开场身份能用的基本信息字段（脱敏：电话、邮箱、账号等不喂给模型） */
const BASIC_INFO_FIELDS = new Set(['姓名', '城市', '学历', '工作年限']);

/**
 * 从「基本信息」节挑开场身份素材。
 *
 * 自我介绍第一句「我是谁」之前没有出处，模型要么自己编要么不说名字。
 * 只要姓名/城市/学历/工作年限四样，电话邮箱账号一律不进 prompt。
 */
function basicInfoForPrompt(md: string): string {
  const doc = parseMarkdownToDocument(md ?? '');
  const section = doc.sections.find((s) => s.key === 'basic');
  if (!section?.contentMd.trim()) return '';
  const lines = section.contentMd
    .split('\n')
    .map((l) => l.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/^([^：:]{1,12})[：:]\s*(.+)$/);
      return m ? { key: m[1].trim(), value: m[2].trim() } : null;
    })
    .filter((p): p is { key: string; value: string } => p !== null && BASIC_INFO_FIELDS.has(p.key))
    .map((p) => `- ${p.key}：${p.value}`);
  return lines.length ? `基本信息（开场身份素材）：\n${lines.join('\n')}` : '';
}

/** 经历的时间跨度；认不出时间返回 null（不参与「并入」判断，宁可不合并也不错并） */
function spanOf(entry: ResumeExperienceEntry): { start: number; end: number } | null {
  const [startText = '', endText = ''] = (entry.period ?? '').split(' ~ ', 2);
  const start = monthKey(startText, 1);
  if (start === null) return null;
  if (entry.ongoing) return { start, end: Number.MAX_SAFE_INTEGER };
  const end = monthKey(endText, 12);
  if (end === null) return null;
  return { start, end };
}

/**
 * 自我介绍专用排序：工作经历是叙事主干，时间落在工作经历期间的项目条目
 * 「并入」该条工作线、紧随其后，避免模型把同一段时期拆成两条经历讲两遍
 * （典型：诺基亚 2011~至今 的工作条目，与同期 Web BTS 项目条目并列时，
 * 模型会把同一段职业生涯报两次时间与职级）。
 */
function orderForSelfIntro(entries: ResumeExperienceEntry[]): {
  ordered: ResumeExperienceEntry[];
  /** 并入工作线的条目下标集合（指 ordered 里的位置） */
  mergedIndexes: Set<number>;
} {
  const works = entries.filter((e) => e.section === 'experience');
  const others = entries.filter((e) => e.section !== 'experience');

  const attach: Array<ResumeExperienceEntry[]> = works.map(() => []);
  for (const project of others) {
    const pSpan = spanOf(project);
    if (!pSpan) continue;
    // 选「开始最晚且仍盖得住这个项目」的工作条目当主干（通常就是最近那份工作）
    let hostIdx = -1;
    let hostStart = -1;
    works.forEach((work, i) => {
      const wSpan = spanOf(work);
      if (!wSpan) return;
      if (pSpan.start >= wSpan.start && pSpan.end <= wSpan.end && wSpan.start > hostStart) {
        hostIdx = i;
        hostStart = wSpan.start;
      }
    });
    if (hostIdx >= 0) attach[hostIdx].push(project);
  }

  const ordered: ResumeExperienceEntry[] = [];
  const mergedIndexes = new Set<number>();
  works.forEach((work, i) => {
    ordered.push(work);
    for (const p of attach[i]) {
      ordered.push(p);
      mergedIndexes.add(ordered.length - 1);
    }
  });
  for (const p of others) {
    if (!ordered.includes(p)) ordered.push(p);
  }
  return { ordered, mergedIndexes };
}

/** 用「自我介绍专用排序」渲染编号经历块；返回空串表示一行时间都认不出 */
function formatSelfIntroTimeline(
  entries: ResumeExperienceEntry[],
  mergedIndexes: Set<number>,
  options: ExperiencePromptOptions = {},
): string {
  const { maxEntries = 6, maxDescriptionChars = 500 } = options;
  const visible = entries.slice(0, maxEntries);
  const lines = visible.map((entry, i) => {
    const who = [entry.org, entry.role].filter(Boolean).join(' · ');
    const merged = mergedIndexes.has(i) && entry.section === 'project';
    const tags = [entry.section === 'project' ? (merged ? '项目·并入工作线' : '项目') : '工作'];
    if (entry.ongoing) tags.push('进行中');
    const head = [`${i + 1}. [${tags.join('·')}]`, entry.period || '（时间未写）', who]
      .filter(Boolean)
      .join(' ');
    const body = entry.description ? `\n${truncate(entry.description, maxDescriptionChars)}` : '';
    return `${head}${body}`;
  });
  if (!lines.length) return '';

  const note =
    mergedIndexes.size > 0
      ? '\n注：标「并入工作线」的项目条目是这条工作经历同期做的项目：讲的时候作为同一条经历（主线讲工作，需要细节时引用对应项目），不要重复报时间与职级。'
      : '';
  return `简历经历（按时间倒序；落在工作经历期间的项目已并入对应工作线并紧随其后；序号越小越近，作答优先取靠前的）：\n${lines.join('\n\n')}${note}`;
}

/**
 * JD 要求与候选素材的轻量关键词匹配。
 *
 * 不做语义理解：把 JD 要求与简历文本都切成「ASCII 词 + 中文二元组」，
 * 按要求被候选文本覆盖的比例 × JD 权重排序。目的是把「模型在 8KB 事实里自己
 * 猜哪段相关」变成「程序先把最可能相关的 3-5 条挑出来」，命中只代表相关，
 * 内容仍然只准从唯一事实来源取。
 */
export interface JdRequirementBrief {
  skill: string;
  weight?: number | null;
}

function tokensOf(text: string): Set<string> {
  const tokens = new Set<string>();
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9]{2,}/g)) tokens.add(m[0]);
  for (const run of text.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const s = run[0];
    for (let i = 0; i + 1 < s.length; i++) tokens.add(s.slice(i, i + 2));
  }
  return tokens;
}

/**
 * 命中统计时从 JD 要求里剔除的泛化二元组：简历正文几乎处处都有，留着只会让
 * 「技术/系统/平台…」式要求点中所有条目，候选清单失去区分度。只作用于 JD
 * 要求一侧——条目文本无需过滤，覆盖率的分母变小即要求「必须命中要求里
 * 有区分度的词」。
 */
const JD_NOISE_BIGRAMS = new Set([
  '技术', '系统', '平台', '开发', '设计', '能力', '工程', '产品', '应用', '解决',
  '支持', '相关', '领域', '方向', '经验', '负责', '主导', '进行', '实现', '提升',
  '业务', '场景', '内容', '组件', '工具', '框架', '方式', '方案', '流程', '质量',
  '功能', '模块', '以及', '要求', '熟悉', '掌握',
]);

function distinctiveReqTokens(skill: string): Set<string> {
  const tokens = tokensOf(skill);
  const distinctive = new Set<string>();
  tokens.forEach((t) => {
    if (!JD_NOISE_BIGRAMS.has(t)) distinctive.add(t);
  });
  return distinctive;
}

const MIN_REQ_COVERAGE = 0.45;

export function selfIntroCandidates(
  resumeMd: string,
  jdRequirements: JdRequirementBrief[] | null | undefined,
): string {
  const reqs = (jdRequirements ?? [])
    .map((r) => ({ skill: (r.skill ?? '').trim(), weight: Number.isFinite(r.weight) ? (r.weight as number) : 0.5 }))
    .filter((r) => r.skill.length > 0);
  if (reqs.length === 0) return '';

  const entries = buildResumeExperienceTimeline(resumeMd);
  const { ordered } = orderForSelfIntro(entries);
  const doc = parseMarkdownToDocument(resumeMd ?? '');

  const items: Array<{ id: string; who: string; text: string }> = [];
  ordered.slice(0, 6).forEach((e, i) => {
    const who = [e.org, e.role].filter(Boolean).join(' · ');
    items.push({ id: `经历条目 ${i + 1}`, who, text: `${who}\n${e.description}` });
  });
  for (const key of ['summary', 'skills'] as const) {
    const section = doc.sections.find((s) => s.key === key);
    if (section?.contentMd.trim()) {
      items.push({ id: catalogTitleForKey(key), who: '', text: section.contentMd });
    }
  }

  const ranked: Array<{ id: string; who: string; score: number; hits: string[] }> = [];
  for (const item of items) {
    const itemTokens = tokensOf(item.text);
    const hits: Array<{ label: string; coverage: number; weight: number }> = [];
    for (const req of reqs) {
      const reqTokens = distinctiveReqTokens(req.skill);
      if (reqTokens.size === 0) continue;
      let matched = 0;
      reqTokens.forEach((t) => {
        if (itemTokens.has(t)) matched += 1;
      });
      const coverage = matched / reqTokens.size;
      if (coverage >= MIN_REQ_COVERAGE) hits.push({ label: req.skill, coverage, weight: req.weight });
    }
    if (hits.length === 0) continue;
    const score = hits.reduce((s, h) => s + h.weight * h.coverage, 0);
    const topHits = hits
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 3)
      .map((h) => `${h.label}(${(h.weight * 100).toFixed(0)}%)`);
    ranked.push({ id: item.id, who: item.who, score, hits: topHits });
  }
  ranked.sort((a, b) => b.score - a.score);

  const chosen = ranked.slice(0, 5);
  if (chosen.length === 0) return '';
  const lines = chosen.map((c) => {
    const who = c.who ? `（${truncate(c.who, 40)}）` : '';
    return `- ${c.id}${who}｜命中：${c.hits.join('、')}`;
  });
  return `【岗位匹配候选素材：按 JD 要求权重预筛，主线与匹配桥优先从这里选（命中只说明相关，内容仍以唯一事实来源原文为准）】\n${lines.join('\n')}`;
}

/** parsed 缺失时从「专业技能」节兜底提取技能清单，让「简历技能」行不至于空着 */
export function skillsFromResumeMd(resumeMd: string): string[] {
  const doc = parseMarkdownToDocument(resumeMd ?? '');
  const section = doc.sections.find((s) => s.key === 'skills');
  if (!section?.contentMd.trim()) return [];
  const skills: string[] = [];
  for (const raw of section.contentMd.split('\n')) {
    const line = raw.replace(/^[-*]\s*/, '').trim();
    if (!line) continue;
    const colon = line.match(/^[^：:]{1,20}[：:]\s*(.+)$/);
    const items = colon ? colon[1].split(/[、，,]/) : [line];
    for (const part of items) {
      const item = part.trim();
      if (item.length >= 1 && item.length <= 40 && !/^语言能力$/.test(item)) skills.push(item);
      if (skills.length >= 15) return skills;
    }
  }
  return skills;
}

/**
 * 自我介绍参考答案的简历事实块：身份素材 + 经历时间线（工作线并入排序）+
 * 岗位匹配候选素材 + 个人优势/技能/教育/意向等，
 * 比通用面试上下文更完整，减少模型为「写满一段介绍」而瞎编。
 * jdRequirements 有值时才生成候选素材块（两端都传 JD parsed requirements）。
 */
export function resumeFactsBlockForSelfIntro(
  resumeMd: string,
  fallbackProjects?: FallbackProject[] | null,
  jdRequirements?: JdRequirementBrief[] | null,
): string {
  const md = resumeMd ?? '';
  const entries = buildResumeExperienceTimeline(md);
  const { ordered, mergedIndexes } = orderForSelfIntro(entries);
  const timeline = formatSelfIntroTimeline(ordered, mergedIndexes, {
    maxEntries: 6,
    maxDescriptionChars: 500,
  });
  const doc = parseMarkdownToDocument(md);
  const sections: string[] = [];
  for (const key of ['summary', 'skills', 'education', 'intention'] as const) {
    const section = doc.sections.find((s) => s.key === key);
    if (section?.contentMd.trim()) {
      sections.push(`${catalogTitleForKey(key)}：\n${truncate(section.contentMd, 1000)}`);
    }
  }

  const body = [
    basicInfoForPrompt(md),
    timeline,
    selfIntroCandidates(md, jdRequirements),
    ...sections,
  ]
    .filter(Boolean)
    .join('\n\n');
  if (body) return `${SELF_INTRO_FACTS_HEADER}\n\n${body}`;

  return `${SELF_INTRO_FACTS_HEADER}\n\n${resumeExperienceBlock(md, fallbackProjects)}`;
}
