/**
 * 一个 Story 的事实集合：三档口述唯一的输入。
 *
 * 「不同口述版本共享事实集合」这条验收，如果只靠 prompt 里写一句「不要编造」，
 * 实际会退化成三次独立生成：30 秒那版说提升了 3 倍，120 秒那版说提升了 5 倍，
 * 用户背哪一条都对不上简历。所以事实集合在代码里是一个真实存在的东西：
 *
 * - 它只由「Story 那一行 + 它关联的已确认证据」推导，别的地方拿不到入口；
 * - 它有内容指纹（hash），每个口述版本落库时把指纹一起记下来，三档的指纹必须
 *   一致，事后可以直接查出某一档是不是在另一组事实上生成的；
 * - 生成结果要过一次数字校验：口述里出现的数字必须在事实集合里找得到。
 *
 * 数字是刻意选的那条线。措辞加工是这件事的目的——30 秒版本必须把话说短，删掉
 * 定语、合并句子都是对的；而编造几乎总是发生在指标上（QPS、倍数、人数、耗时），
 * 因为那是面试官唯一会追着问「怎么算出来的」的地方。校验数字既挡住了最危险的
 * 那类漂移，又不会把正常的口语化改写判成违规。
 */

import type { CandidateEvidence } from '../entities';
import { sha256 } from '../plugins/resolver';
import type { Story, StoryDeliveryDuration } from './types';

export interface StoryFact {
  /** `story.situation` 或 `evidence:<id>`，出现在 prompt 里供模型引用 */
  id: string;
  label: string;
  text: string;
}

export interface StoryFactSet {
  storyId: string;
  facts: StoryFact[];
  /** 事实集合的内容指纹；口述版本落库时一起记下 */
  hash: string;
}

type StorySegmentKey = 'situationMd' | 'taskMd' | 'actionMd' | 'resultMd' | 'reflectionMd';

const STAR_SEGMENTS: ReadonlyArray<{ key: StorySegmentKey; id: string; label: string }> = [
  { key: 'situationMd', id: 'story.situation', label: '情境（S）' },
  { key: 'taskMd', id: 'story.task', label: '任务（T）' },
  { key: 'actionMd', id: 'story.action', label: '行动（A）' },
  { key: 'resultMd', id: 'story.result', label: '结果（R）' },
  { key: 'reflectionMd', id: 'story.reflection', label: '复盘（R）' },
];

/**
 * 组装事实集合。
 *
 * 证据按 id 排序而不是按传入顺序：指纹要能跨设备、跨读取顺序稳定复现，否则
 * 「三档指纹一致」这条断言会因为一次 ORDER BY 的差别变成随机失败。
 */
export function buildStoryFactSet(
  story: Story,
  evidence: readonly CandidateEvidence[],
): StoryFactSet {
  const linked = new Set(story.evidenceIds);
  const facts: StoryFact[] = [];

  for (const segment of STAR_SEGMENTS) {
    const text = (story[segment.key] ?? '').trim();
    if (text) facts.push({ id: segment.id, label: segment.label, text });
  }

  const confirmed = evidence
    .filter((item) => item.status === 'confirmed' && linked.has(item.id))
    .slice()
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  for (const item of confirmed) {
    facts.push({
      id: `evidence:${item.id}`,
      label: `证据 · ${item.title}`,
      // 时间和逐字原文都算事实正文，不能只放进标题：口述里说得出的每个数字最终
      // 都要能在这段文字里找到，而年月往往只写在 occurredAt 上
      text: [
        item.statement,
        ...(item.occurredAt ? [`发生时间：${item.occurredAt}`] : []),
        `原文：${item.source.quote}`,
      ].join('\n'),
    });
  }

  return {
    storyId: story.id,
    facts,
    hash: sha256(facts.map((fact) => `${fact.id}\u0000${fact.text}`).join('\u0001')),
  };
}

/** 事实集合在 prompt 里的样子。三档共用这一个渲染函数，不各写一份。 */
export function renderStoryFactSet(factSet: StoryFactSet): string {
  const lines = ['## 本次口述可用的事实集合（唯一来源，不得增补）'];
  for (const fact of factSet.facts) {
    lines.push(`### ${fact.label}｜${fact.id}`, fact.text);
  }
  return lines.join('\n');
}

/**
 * 抽出一段文字里的数字，并归一化成可比较的形式。
 *
 * 归一化处理三件事：千分位逗号（3,000 与 3000 是同一个数）、前导零
 * （occurredAt 里的 2021-03 与口述里的 3 月是同一个月）、以及全角数字。
 */
export function normalizedNumbers(text: string): Set<string> {
  const halfWidth = text.replace(/[\uff10-\uff19]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xfee0),
  );
  const out = new Set<string>();
  for (const match of halfWidth.matchAll(/\d+(?:[.,]\d+)*/g)) {
    const compact = match[0].replace(/,/g, '');
    const trimmed = compact.replace(/^0+(?=\d)/, '');
    out.add(trimmed);
  }
  return out;
}

export interface DeliveryGroundingFailure {
  /** 口述里出现、事实集合里却没有的数字 */
  inventedNumbers: string[];
}

export type DeliveryGroundingResult =
  | { ok: true }
  | { ok: false; failure: DeliveryGroundingFailure };

export interface DeliveryGroundingInput {
  factSet: StoryFactSet;
  duration: StoryDeliveryDuration;
  deliveryMd: string;
}

/**
 * 口述版本的事实校验。
 *
 * 时长本身要放行：模型经常会在正文里写「（60 秒版）」或「大约一分钟」，那不是
 * 一条关于候选人的事实，挡下来只会让每次生成都失败一遍。
 */
export function checkDeliveryGrounding(input: DeliveryGroundingInput): DeliveryGroundingResult {
  const allowed = normalizedNumbers(
    input.factSet.facts.map((fact) => fact.text).join('\n'),
  );
  allowed.add(String(input.duration));
  if (input.duration >= 60) allowed.add(String(input.duration / 60));

  const invented = [...normalizedNumbers(input.deliveryMd)].filter(
    (number) => !allowed.has(number),
  );
  if (invented.length === 0) return { ok: true };
  return { ok: false, failure: { inventedNumbers: invented } };
}
