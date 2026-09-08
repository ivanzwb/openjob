import { describe, expect, it } from 'vitest';
import { findUncoveredRequirements, uncoveredRequirementsMessage } from './coverage';

describe('findUncoveredRequirements', () => {
  it('英文技术词命中即视为已覆盖', () => {
    const uncovered = findUncoveredRequirements(
      [{ skill: '熟悉 MySQL 索引优化', weight: 0.8 }],
      ['MySQL 索引', '慢查询'],
    );

    expect(uncovered).toEqual([]);
  });

  it('中文按二元组比对，「索引优化」能被「MySQL 索引」接住', () => {
    const uncovered = findUncoveredRequirements(
      [{ skill: '索引优化', weight: 0.6 }],
      ['MySQL 索引'],
    );

    expect(uncovered).toEqual([]);
  });

  it('报出没有任何考点接住的要求', () => {
    const uncovered = findUncoveredRequirements(
      [
        { skill: '熟悉 Kubernetes 集群运维', weight: 0.9 },
        { skill: '熟悉 MySQL', weight: 0.5 },
      ],
      ['MySQL 索引'],
    );

    expect(uncovered).toEqual(['熟悉 Kubernetes 集群运维']);
  });

  it('按权重从高到低排序，重要的缺口先报', () => {
    const uncovered = findUncoveredRequirements(
      [
        { skill: 'Kafka 消息队列', weight: 0.3 },
        { skill: 'Kubernetes 编排', weight: 0.9 },
      ],
      ['MySQL 索引'],
    );

    expect(uncovered).toEqual(['Kubernetes 编排', 'Kafka 消息队列']);
  });

  it('整条都是套话时不报——「良好的沟通能力」不该变成考点缺口', () => {
    const uncovered = findUncoveredRequirements(
      [{ skill: '良好的沟通能力', weight: 0.2 }],
      ['MySQL 索引'],
    );

    expect(uncovered).toEqual([]);
  });

  it('单字重合不算命中，避免「检索」把「索引」当成已覆盖', () => {
    const uncovered = findUncoveredRequirements(
      [{ skill: '全文检索', weight: 0.7 }],
      ['索引下推'],
    );

    expect(uncovered).toEqual(['全文检索']);
  });
});

describe('uncoveredRequirementsMessage', () => {
  it('全部覆盖时不追加任何文字', () => {
    expect(uncoveredRequirementsMessage([])).toBe('');
  });

  it('超过三条时只列前三条并给出总数', () => {
    const message = uncoveredRequirementsMessage(['分布式事务', '服务网格', '可观测性', 'Kafka']);

    expect(message).toContain('分布式事务、服务网格、可观测性');
    expect(message).toContain('4 条');
    expect(message).not.toContain('Kafka');
  });
});
