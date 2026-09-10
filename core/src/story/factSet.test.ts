/**
 * 事实集合的纯函数层。
 *
 * 这一层要守住的是「三档口述共享同一组事实」这条验收里可以脱离数据库验证的部分：
 * 指纹只由内容决定（读取顺序、时长都不影响），以及数字校验真的能挡下编造。
 */
import { describe, expect, it } from 'vitest';
import type { CandidateEvidence } from '../entities';
import {
  buildStoryFactSet,
  checkDeliveryGrounding,
  normalizedNumbers,
  renderStoryFactSet,
} from './factSet';
import type { Story } from './types';

function evidence(overrides: Partial<CandidateEvidence> & { id: string }): CandidateEvidence {
  return {
    campaignId: 'c-acme',
    kind: 'achievement',
    title: '订单履约链路重构',
    statement: '主导订单履约链路重构，高峰 QPS 从 3000 提到 12000',
    source: {
      kind: 'resume',
      documentId: 'r-1',
      start: 0,
      end: 10,
      quote: '主导订单履约链路重构，高峰 QPS 从 3000 提到 12000',
    },
    occurredAt: null,
    confidence: 1,
    status: 'confirmed',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function story(overrides: Partial<Story> = {}): Story {
  return {
    id: 's-1',
    campaignId: 'c-acme',
    title: '订单履约链路重构',
    situationMd: '大促前订单履约链路频繁超时。',
    taskMd: '我负责把高峰期的吞吐提上来。',
    actionMd: '拆出异步补偿队列，重写幂等键。',
    resultMd: '大促当天没有再出现超时。',
    reflectionMd: '',
    evidenceIds: ['ev-1'],
    competencyIds: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('事实集合的组装', () => {
  it('只收已确认、且真的挂在这个 Story 上的证据', () => {
    const factSet = buildStoryFactSet(story({ evidenceIds: ['ev-1'] }), [
      evidence({ id: 'ev-1' }),
      // 状态被拒的那条不该再出现在事实里——它已经不是一件成立的事
      evidence({ id: 'ev-2', status: 'rejected', statement: '拒掉的经历' }),
      // 没挂在这个 Story 上的证据同样不进来，否则口述会讲到别的经历
      evidence({ id: 'ev-3', statement: '另一段经历' }),
    ]);

    expect(factSet.facts.map((fact) => fact.id)).toEqual([
      'story.situation',
      'story.task',
      'story.action',
      'story.result',
      'evidence:ev-1',
    ]);
  });

  it('空白段落不进事实集合，也不影响指纹', () => {
    const withEmpty = buildStoryFactSet(story({ reflectionMd: '   ' }), [evidence({ id: 'ev-1' })]);
    const without = buildStoryFactSet(story({ reflectionMd: '' }), [evidence({ id: 'ev-1' })]);

    expect(withEmpty.facts.some((fact) => fact.id === 'story.reflection')).toBe(false);
    expect(withEmpty.hash).toBe(without.hash);
  });

  it('证据的读取顺序不改变指纹——否则「三档指纹一致」会因为一次排序差别随机失败', () => {
    const first = buildStoryFactSet(story({ evidenceIds: ['ev-1', 'ev-2'] }), [
      evidence({ id: 'ev-1' }),
      evidence({ id: 'ev-2', statement: '带 4 人小组完成迁移' }),
    ]);
    const reversed = buildStoryFactSet(story({ evidenceIds: ['ev-2', 'ev-1'] }), [
      evidence({ id: 'ev-2', statement: '带 4 人小组完成迁移' }),
      evidence({ id: 'ev-1' }),
    ]);

    expect(reversed.hash).toBe(first.hash);
  });

  it('改了任何一段内容，指纹就变——事实集合是按内容认的，不是按 id 认的', () => {
    const before = buildStoryFactSet(story(), [evidence({ id: 'ev-1' })]);
    const after = buildStoryFactSet(story({ resultMd: '大促当天超时下降了一半。' }), [
      evidence({ id: 'ev-1' }),
    ]);

    expect(after.hash).not.toBe(before.hash);
  });

  it('时间写在 occurredAt 上时也算事实正文，口述里说出年月不该被判成编造', () => {
    const factSet = buildStoryFactSet(story(), [evidence({ id: 'ev-1', occurredAt: '2023-05' })]);

    expect(renderStoryFactSet(factSet)).toContain('2023-05');
    expect(
      checkDeliveryGrounding({
        factSet,
        duration: 60,
        deliveryMd: '2023 年 5 月我接手了订单履约链路。',
      }),
    ).toEqual({ ok: true });
  });
});

describe('数字归一化', () => {
  it('千分位、前导零和全角数字都算同一个数', () => {
    expect(normalizedNumbers('3,000 与 3000')).toEqual(new Set(['3000']));
    expect(normalizedNumbers('05 月')).toEqual(new Set(['5']));
    expect(normalizedNumbers('提升 ３ 倍')).toEqual(new Set(['3']));
  });

  it('小数保留精度：99.9% 和 99% 不是同一个承诺', () => {
    expect(normalizedNumbers('可用性 99.9%')).toEqual(new Set(['99.9']));
  });
});

describe('口述的事实校验', () => {
  const factSet = buildStoryFactSet(story(), [evidence({ id: 'ev-1' })]);

  it('措辞压缩是允许的：只要没冒出新数字就通过', () => {
    expect(
      checkDeliveryGrounding({
        factSet,
        duration: 30,
        deliveryMd: '大促前履约链路老超时，我拆了异步补偿队列，QPS 从 3000 做到 12000。',
      }),
    ).toEqual({ ok: true });
  });

  it('多出一个指标就拒——这正是面试官会追着问「怎么算出来的」的地方', () => {
    const result = checkDeliveryGrounding({
      factSet,
      duration: 120,
      deliveryMd: 'QPS 从 3000 提到 12000，超时率下降了 87%。',
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.inventedNumbers).toEqual(['87']);
  });

  it('时长本身放行：模型经常在正文里写「60 秒版」或「大约一分钟」', () => {
    expect(
      checkDeliveryGrounding({ factSet, duration: 60, deliveryMd: '（60 秒版）大约 1 分钟讲完。' }),
    ).toEqual({ ok: true });
  });
});
