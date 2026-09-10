import type { JdParsed } from '@core/entities';

/**
 * JD 要求与考点清单的对账。
 *
 * 建树只让模型「尽量覆盖」，没有任何一步核对结果——JD 里明写的要求被漏掉时，
 * 用户要把清单和 JD 逐条对着看才发现。这里按名称重合度做一次粗对账，漏了就报出来。
 *
 * 判定刻意宽松：宁可漏报，也不要把已经覆盖的要求当成缺口反复提示。
 */

/**
 * JD 里描述熟练度和软性条件的套话，本身不指向任何考点。
 *
 * 必须在切二元组之前整词删掉：留到之后再过滤，「良好的沟通能力」还会剩下
 * 「好的」「的沟」「通能」这些跨词残片，照样被当成技术词去比对。
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
  '沟通',
  '团队',
  '协作',
  '学习',
];

function latinTokens(name: string): string[] {
  return (name.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2);
}

/**
 * 中文按二元组切，不按单字。
 *
 * 单字粒度下「索引」和「检索」共享一个「索」就算命中，噪声太大；二元组既不需要
 * 分词器，又能把「索引」「持久」这类真正的技术词切出来。
 */
function cjkBigrams(name: string): string[] {
  const cjkOnly = name.replace(/[^\u4e00-\u9fff]+/g, ' ');
  const out: string[] = [];
  for (const run of cjkOnly.split(' ')) {
    for (let i = 0; i + 1 < run.length; i++) {
      out.push(run.slice(i, i + 2));
    }
  }
  return out;
}

function signatureOf(name: string): string[] {
  return latinTokens(name).concat(cjkBigrams(name));
}

/** 要求侧先去掉套话和结构助词，剩下的才是真正指向考点的部分 */
function requirementSignature(skill: string): string[] {
  let stripped = skill;
  for (const phrase of GENERIC_PHRASES) stripped = stripped.split(phrase).join(' ');
  stripped = stripped.replace(/[的和与及等或者]/g, ' ');
  return signatureOf(stripped);
}

/**
 * 找出没有任何考点接住的 JD 要求，按权重从高到低返回。
 *
 * 一条要求只要和某个考点共享一个技术词（英文词或中文二元组）就算被覆盖。
 */
export function findUncoveredRequirements(
  requirements: JdParsed['requirements'],
  nodeNames: readonly string[],
): string[] {
  const covered = new Set<string>();
  for (const name of nodeNames) {
    for (const token of signatureOf(name)) covered.add(token);
  }

  return requirements
    .filter((req) => {
      const signature = requirementSignature(req.skill);
      // 整条要求都是套话时无从判断，不报
      if (signature.length === 0) return false;
      return !signature.some((token) => covered.has(token));
    })
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .map((req) => req.skill);
}

/** 拼进任务完成消息的尾巴；全部覆盖时返回空串 */
export function uncoveredRequirementsMessage(uncovered: readonly string[]): string {
  if (uncovered.length === 0) return '';
  const shown = uncovered.slice(0, 3).join('、');
  const rest = uncovered.length > 3 ? `等 ${uncovered.length} 条要求` : '';
  return `；JD 中「${shown}」${rest}未覆盖，可手动补充考点`;
}
