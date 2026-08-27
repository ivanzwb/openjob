/**
 * 把简历经历按与当前问题的相关度排序，供 prompt 取前几条。
 *
 * 只排序，不裁决。这里曾经有一道覆盖率门禁，低于阈值的经历会被判成「不相关」而
 * 整条剔除，挑不出任何一条时 prompt 里写的是「简历里没有与本题直接相关的经历」。
 * 拆掉它是因为词法匹配撑不起这么强的断言：
 *
 * - 它跨不过同义词。考点「K8s」配简历里的 Kubernetes、考点「MVCC」配「多版本
 *   并发控制」、考点「消息队列」配 Kafka，全都零命中。中文技术简历恰恰普遍是
 *   考点写中文概念名、简历写英文实现名，这不是边角情况。
 * - 两类错误的代价差得很远。多带进一条不太相关的经历，模型顶多不用它；漏掉一条
 *   真相关的，用户会被明确告知「你简历里没有这方面经历」然后拿到一个通用答案，
 *   而他明明有。
 * - 门禁其实也没省下多少篇幅。经历块本来就封顶四条、每条四百字，多数人的简历
 *   一共就三到五段——门禁筛掉的往往只有一两段。
 *
 * 所以「哪几段真的相关」交给下游那次本来就要发生的 LLM 调用去判断：它知道 Kafka
 * 是消息队列，而正字法匹配永远不知道。词法在这里只负责两件它做得好的事——长简历
 * 裁到四条，以及把最可能相关的排在前面。
 *
 * 为什么不用嵌入：`embedText` 走网络，而 `resolveEmbedding()` 在用户没选嵌入模型
 * 时直接抛错；手机端更是完全没有嵌入能力。把简历检索建在向量上，等于双端行为
 * 不一致，且没配嵌入的用户直接退化成零检索。
 *
 * 为什么中文要在这份简历自己的经历上算 IDF：中文没有空格，只能切二元组，而
 * 「项目」「系统」「使用」「负责」这类二元组在每条经历里都出现，按原始重叠算会
 * 让所有经历得分接近、排序退化成随机。停用词表永远维护不完，而文档频率是现成
 * 且自适应的判别力度量。语料就是这个人的几条经历，不需要外部词表和配置。
 */

import {
  buildResumeExperienceTimeline,
  type FallbackProject,
  type ResumeExperienceEntry,
} from './experienceTimeline';

/** 技术词信号远强于中文二元组：命中一个 Kafka 比蹭上三个「系统」有意义得多 */
const LATIN_WEIGHT = 3;
const CJK_WEIGHT = 1;

const LATIN_TOKEN = /[a-z0-9][a-z0-9+#._-]*/g;
const CJK_RUN = /[\u4e00-\u9fff]+/g;
/** 单独一个非全局的：带 g 的正则 .test() 会累积 lastIndex，连续调用交替返回真假 */
const HAS_CJK = /[\u4e00-\u9fff]/;
const ALL_DIGITS = /^\d+$/;

/**
 * 拉丁词：长度 1 的丢掉（单个 c / r 噪声远大于信号），纯数字也丢掉——
 * 「2021」这类年份和数量词会让日期蹭出相关性。
 */
function latinTokens(text: string): string[] {
  return (text.toLowerCase().match(LATIN_TOKEN) ?? []).filter(
    (t) => t.length >= 2 && !ALL_DIGITS.test(t),
  );
}

/** 中文按二元组切；整段只有一个汉字时保留那个字 */
function cjkBigrams(text: string): string[] {
  const out: string[] = [];
  for (const run of text.match(CJK_RUN) ?? []) {
    if (run.length === 1) {
      out.push(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

function termsOf(text: string): Set<string> {
  return new Set([...latinTokens(text), ...cjkBigrams(text)]);
}

export interface ResumeRelevanceQuery {
  /** 考点名。四条链路都有 */
  nodeName?: string | null;
  /** 用户这一轮实际输入：追加要求、划选的原文、答题内容 */
  userText?: string | null;
}

/** 考点名和用户输入合成一个词集：只用来排序，不必再分开设命中门槛 */
function queryTerms(query: ResumeRelevanceQuery): Set<string> {
  return termsOf(`${query.nodeName ?? ''} ${query.userText ?? ''}`);
}

interface Scored<T> {
  doc: T;
  /** 命中项的加权和 */
  score: number;
  /** 原始顺序里的位置。经历时间线是倒序的，所以 0 就是最近的一段 */
  index: number;
}

/**
 * 词法打分。分数只用来排序，不用来判定相关与否。
 *
 * 只有中文二元组乘 IDF，拉丁技术词不乘——这是这个打分函数里唯一需要解释的决定。
 * IDF 度量的是「在这份简历内部的判别力」：某个词只出现在一条经历里，那条就是最该
 * 先拿出来的。但拉丁词（Kafka / MVCC / Redis / React）出现得多，只说明这个人一直
 * 在做它，把它的权重压到零会让「三份工作都在做 Kafka」的人问 Kafka 时排序全平，
 * 所以按固定权重全额计入。中文二元组相反：「项目」「负责」「系统」这类到处都有，
 * 不靠 df 根本分不开，而停用词表永远维护不完。
 *
 * 没做长度归一化：经历条目篇幅本来就接近（几百字），而更长的描述确实承载更多
 * 相关内容，为几条文档做归一化只会引入一个没人能调的旋钮。
 */
function rankDocs<T>(
  docs: T[],
  textOf: (doc: T) => string,
  query: ResumeRelevanceQuery,
): Scored<T>[] {
  if (docs.length === 0) return [];
  const qTerms = queryTerms(query);

  const docTerms = docs.map((d) => termsOf(textOf(d)));
  const df = new Map<string, number>();
  for (const terms of docTerms) {
    for (const t of terms) df.set(t, (df.get(t) ?? 0) + 1);
  }

  // BM25 那一版 IDF，再除以「只出现在一条经历里」时的取值归一到 (0,1]，
  // 让「某词只出现在一条经历里」恒等于满权重，不随简历长短漂移。
  const n = docs.length;
  const rawIdf = (d: number): number => Math.log(1 + (n - d + 0.5) / (d + 0.5));
  const idfMax = rawIdf(1);
  const idf = (term: string): number => {
    if (idfMax === 0) return 1;
    return rawIdf(df.get(term) ?? n) / idfMax;
  };

  // 拉丁技术词不乘 IDF（见上），中文乘
  const hitWeight = (t: string): number =>
    HAS_CJK.test(t) ? CJK_WEIGHT * idf(t) : LATIN_WEIGHT;

  return docs
    .map((doc, index) => {
      const terms = docTerms[index]!;
      let score = 0;
      for (const t of qTerms) {
        if (terms.has(t)) score += hitWeight(t);
      }
      return { doc, score, index };
    })
    // 命中得更多更全的排前面。一条都没命中的得零分，自然沉到最后，但仍然留在
    // 列表里——词法看不出同义关系，零分不代表不相关。同分按原顺序，也就是时间
    // 近的优先：面试官问的是你现在的水平。
    .sort((a, b) => b.score - a.score || a.index - b.index);
}

export interface RankedResumeEntry {
  entry: ResumeExperienceEntry;
  score: number;
  /** 时间倒序里的位置，0 为最近 */
  recencyIndex: number;
}

/** 按与问题的相关度排序的经历；不做剔除，简历里有几条就返回几条 */
export function rankResumeExperience(
  resumeMd: string,
  query: ResumeRelevanceQuery,
): RankedResumeEntry[] {
  const entries = buildResumeExperienceTimeline(resumeMd ?? '');
  return rankDocs(entries, (e) => `${e.org} ${e.role} ${e.description}`, query).map((s) => ({
    entry: s.doc,
    score: s.score,
    recencyIndex: s.index,
  }));
}

/** 项目摘要的相关度排序，供简历没写时间、抽不出时间线时使用 */
export function rankResumeProjects(
  projects: FallbackProject[] | null | undefined,
  query: ResumeRelevanceQuery,
): FallbackProject[] {
  return rankDocs(
    projects ?? [],
    (p) => `${p.name} ${p.summary} ${p.drillableTopics.join(' ')}`,
    query,
  ).map((s) => s.doc);
}

/**
 * 简历关联了、但一条经历条目都抽不出来时的说明（纯技能列表、格式不规范的简历）。
 *
 * 和「没关联简历」是两件事，措辞分开：这里简历是有的，只是抽不出可引用的经历。
 */
export const NO_EXPERIENCE_ENTRIES_NOTICE = `简历经历：（简历里没有可引用的经历条目）
- 不要虚构候选人的项目或经历，也不要拿 JD、公司技术栈里的内容冒充候选人做过的事。
- 需要举例时用通用场景，并标注「可换成你简历里的对应经历」。`;

/**
 * 经历块的表头和用法说明。
 *
 * 这段话承担的是原先那道词法门禁的职责。排序由关键词重叠算出，而关键词看不出
 * 「Kafka 就是消息队列」「K8s 就是 Kubernetes」这类同义关系，所以必须明说排序
 * 只是粗排、真正的相关性判断由模型来做——否则模型会默认第一条就是相关的那条。
 *
 * 「都不相关就直说」这条不能省：少了它，模型面对一堆无关经历仍然会挑一条硬套，
 * 用户照着背，被追问两句就穿帮。
 */
const EXPERIENCE_HEADER =
  '简历经历（按与本题的关键词重叠度粗排，仅供参考——关键词看不出「Kafka 就是消息队列」这类同义关系，不代表排在前面的就相关）：';

const EXPERIENCE_USAGE = `经历使用规则：
- 先判断上面哪几段与本题真的相关，作答里「我做过」的部分只能取自那几段。
- 若都不相关，直说「这块简历里没有直接经历」，改用通用场景举例，并标注「可换成你简历里的对应经历」。
- 不要把无关经历硬套到本题上，也不要拿 JD、公司技术栈里的内容冒充候选人做过的事。`;

/** 命中点靠后时，窗口往前留一点上下文，别让句子从半截开始 */
const MATCH_LEAD_IN = 60;

/**
 * 截断时保证命中的证据还在窗口里。
 *
 * 从头截会把这条经历之所以被选中的那句话切掉：一段四百字开外才提到 Kafka 的
 * 描述，按相关度选进来之后又被截成前 400 字，模型看到的是一段和题目无关的文字，
 * 却被告知「这是与本题相关的经历」——比不给还糟，它会照着这段编。
 */
function truncateAroundMatch(text: string, max: number, needles: Set<string>): string {
  const t = text.trim();
  if (t.length <= max) return t;

  const lower = t.toLowerCase();
  let first = -1;
  for (const n of needles) {
    const i = lower.indexOf(n);
    if (i >= 0 && (first < 0 || i < first)) first = i;
  }

  // 证据本来就在窗口内（含压根没命中的情况），按原来的方式截
  if (first < 0 || first < max) return `${t.slice(0, max)}…`;

  const start = Math.max(0, first - MATCH_LEAD_IN);
  return `…${t.slice(start, start + max)}…`;
}

export interface RelevantBlockOptions {
  maxEntries?: number;
  maxDescriptionChars?: number;
  /** 简历抽不出带时间的经历时退回的项目摘要 */
  fallbackProjects?: FallbackProject[] | null;
}

/**
 * 注入 prompt 的经历段落：按相关度粗排、裁到 maxEntries 条，附带让模型自行判断
 * 相关性的用法说明。每条带着时间和「进行中」标记，新旧照样看得出来。
 */
export function relevantResumeExperienceBlock(
  resumeMd: string,
  query: ResumeRelevanceQuery,
  options: RelevantBlockOptions = {},
): string {
  const { maxEntries = 4, maxDescriptionChars = 400, fallbackProjects } = options;

  const needles = queryTerms(query);

  const ranked = rankResumeExperience(resumeMd, query);
  if (ranked.length > 0) {
    const lines = ranked.slice(0, maxEntries).map((r, i) => {
      const who = [r.entry.org, r.entry.role].filter(Boolean).join(' · ');
      const tag = r.entry.section === 'project' ? '项目' : '工作';
      const head = [
        `${i + 1}. [${tag}${r.entry.ongoing ? '·进行中' : ''}]`,
        r.entry.period || '（时间未写）',
        who,
      ]
        .filter(Boolean)
        .join(' ');
      const body = r.entry.description
        ? `\n${truncateAroundMatch(r.entry.description, maxDescriptionChars, needles)}`
        : '';
      return `${head}${body}`;
    });
    return `${EXPERIENCE_HEADER}\n${lines.join('\n\n')}\n\n${EXPERIENCE_USAGE}`;
  }

  const projects = rankResumeProjects(fallbackProjects, query).slice(0, maxEntries);
  if (projects.length > 0) {
    const summary = projects
      .map((p) => `${p.name}：${p.summary}；可深挖：${p.drillableTopics.slice(0, 4).join('、')}`)
      .join('\n');
    return `简历项目（简历未填写时间，无法判断新旧；按与本题的关键词重叠度粗排，仅供参考）：\n${summary}\n\n${EXPERIENCE_USAGE}`;
  }

  return NO_EXPERIENCE_ENTRIES_NOTICE;
}
