/**
 * 能力模板 × JD 要求 / 候选人证据 的文本对账。
 *
 * 全部走确定性的词面重合，不问模型。这一步的输出直接决定覆盖类型和证据风险，
 * 而这两个值又进优先级——让模型来判，同一份 JD 每跑一次就能排出不同的顺序，
 * 用户没法复核，也没法解释昨天为什么排第一。
 *
 * 判定按「命中能力名称算两分、只命中描述算一分，满两分才算相关」来定。名称是
 * 岗位包作者写死的短词组，信号密度高；描述是长句，单个词重合（「核心」「工程」）
 * 在任何岗位的证据里都能撞上，只配当旁证。
 */

/**
 * JD 和证据里描述熟练度的套话，本身不指向任何能力。
 *
 * 必须在切二元组之前整词删掉：留到之后再过滤，「良好的沟通能力」还会剩下
 * 「好的」「的沟」「通能」这些跨词残片，照样被当成实词去比对。
 *
 * 这份名单比 diagnosis/coverage.ts 那份短，少的是「沟通」「团队」「协作」。那边比的是
 * 技术考点，这几个词只会带来噪声；这边比的是能力，产品、销售、HR 的岗位包里正有
 * 「跨团队推动与对齐」这类能力，删掉它们等于让非工程岗位的核心能力永远匹配不上。
 */
const GENERIC_PHRASES = [
  '熟悉',
  '精通',
  '掌握',
  '了解',
  '具备',
  '负责',
  '参与',
  '理解',
  '能力',
  '经验',
  '优先',
  '相关',
  '良好',
  '以上',
  '扎实',
  '深入',
  '熟练',
  '优秀',
  '较强',
  '完成',
];

/** 命中名称的权重。名称里的词是岗位包作者挑过的，比描述里的实词可靠得多 */
const NAME_HIT_WEIGHT = 2;
const DESCRIPTION_HIT_WEIGHT = 1;

/** 满两分才算相关：一个描述词的重合在跨岗位的文本里几乎必然发生 */
export const MATCH_SCORE_THRESHOLD = 2;

/** relevance 的饱和常数，命中 2 分 → 0.5，4 分 → 0.67，6 分 → 0.75 */
const RELEVANCE_HALF_POINT = 2;

function latinTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9+#]+/g) ?? []).filter((token) => token.length >= 2);
}

/**
 * 中文按二元组切，不按单字。
 *
 * 单字粒度下「用户」和「用例」共享一个「用」就算命中，噪声大到没法用；二元组
 * 既不需要分词器，又能把「用户」「增长」这类真正的实词切出来。
 */
function cjkBigrams(text: string): string[] {
  const cjkOnly = text.replace(/[^\u4e00-\u9fff]+/g, ' ');
  const out: string[] = [];
  for (const run of cjkOnly.split(' ')) {
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

export function textSignature(text: string): Set<string> {
  let stripped = text;
  for (const phrase of GENERIC_PHRASES) stripped = stripped.split(phrase).join(' ');
  stripped = stripped.replace(/[的和与及等或者]/g, ' ');
  return new Set(latinTokens(stripped).concat(cjkBigrams(stripped)));
}

/** 能力模板的两级词面签名，name 与 description 分开保存以便区别计分 */
export interface CompetencySignature {
  name: Set<string>;
  description: Set<string>;
}

export function competencySignature(template: {
  name: string;
  description: string;
}): CompetencySignature {
  const name = textSignature(template.name);
  const description = textSignature(template.description);
  // 名称里已经有的词不在描述里再算一次，否则同一个词吃到三分
  for (const token of name) description.delete(token);
  return { name, description };
}

export interface MatchResult {
  matched: boolean;
  /** 0–1，命中越多越接近 1 */
  relevance: number;
  /** 命中的词，最多几个，用来给用户解释判定依据 */
  hits: string[];
}

export function matchAgainstCompetency(
  signature: CompetencySignature,
  text: string,
): MatchResult {
  const candidate = textSignature(text);
  const hits: string[] = [];
  let score = 0;

  for (const token of candidate) {
    if (signature.name.has(token)) {
      score += NAME_HIT_WEIGHT;
      hits.push(token);
    } else if (signature.description.has(token)) {
      score += DESCRIPTION_HIT_WEIGHT;
      hits.push(token);
    }
  }

  if (score < MATCH_SCORE_THRESHOLD) return { matched: false, relevance: 0, hits: [] };
  return {
    matched: true,
    relevance: score / (score + RELEVANCE_HALF_POINT),
    hits,
  };
}
