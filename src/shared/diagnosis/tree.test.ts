import { describe, expect, it } from 'vitest';
import type { GeneratedNode } from './prompts';
import {
  findCrossLevelDuplicate,
  findSameLevelDuplicate,
  flattenGeneratedTree,
} from './tree';

function counterIds(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

const tree: GeneratedNode[] = [
  {
    name: '分布式系统',
    kind: 'domain',
    coverageType: 'deepDive',
    examProb: 0.8,
    difficulty: 4,
    estMinutes: 60,
    examForms: ['design'],
    children: [
      {
        name: '一致性协议',
        kind: 'topic',
        coverageType: 'deepDive',
        examProb: 0.7,
        difficulty: 4,
        estMinutes: 45,
        examForms: ['concept'],
      },
    ],
  },
];

describe('flattenGeneratedTree', () => {
  it('只用调用方给的 ID 工厂，不碰任何全局 crypto', () => {
    // 这个函数两端共用：桌面端有 globalThis.crypto，React Native 没有。
    // 曾经写死 globalThis.crypto.randomUUID() 导致手机端一诊断就炸，
    // 且此前已经删掉旧考点，用户看到的是考点清单凭空消失。
    const rows = flattenGeneratedTree('c1', tree, counterIds());

    expect(rows.map((r) => r.id)).toEqual(['id-1', 'id-2']);
  });

  it('顶层节点 parentId 为 null，子节点挂到父节点 ID 上', () => {
    const rows = flattenGeneratedTree('c1', tree, counterIds());

    expect(rows[0]).toMatchObject({ campaignId: 'c1', name: '分布式系统', parentId: null });
    expect(rows[1]).toMatchObject({ name: '一致性协议', parentId: rows[0]!.id });
  });

  it('ID 工厂抛错时整体抛出，不返回半棵树', () => {
    const boom = (): string => {
      throw new Error('no uuid here');
    };

    expect(() => flattenGeneratedTree('c1', tree, boom)).toThrow('no uuid here');
  });

  it('同名节点去重后不再消耗 ID', () => {
    const dup: GeneratedNode[] = [tree[0]!, { ...tree[0]!, children: [] }];
    const rows = flattenGeneratedTree('c1', dup, counterIds());

    expect(rows.filter((r) => r.name === '分布式系统')).toHaveLength(1);
  });
});

describe('findSameLevelDuplicate', () => {
  it('完全同名、互相包含、token 超集都算重复', () => {
    expect(findSameLevelDuplicate(['索引优化'], '索引优化')).toBe('索引优化');
    expect(findSameLevelDuplicate(['索引'], '索引下推')).toBe('索引');
    expect(
      findSameLevelDuplicate(['Python AI/ML 生态与数据处理基础'], 'Python与AI/ML生态'),
    ).toBe('Python AI/ML 生态与数据处理基础');
  });

  it('无关名称不算重复', () => {
    expect(findSameLevelDuplicate(['索引优化'], '事务隔离级别')).toBeNull();
  });
});

describe('findCrossLevelDuplicate', () => {
  // 这条曾经沿用同层的包含判定，代价是细化「索引」时子考点全被判成重复丢掉，
  // 一次模型调用换不回任何新考点，表现出来就是考点覆盖不全。
  it('父子共享前缀不算重复', () => {
    expect(findCrossLevelDuplicate(['索引'], '索引下推')).toBeNull();
    expect(findCrossLevelDuplicate(['索引'], '聚簇索引')).toBeNull();
    expect(findCrossLevelDuplicate(['Redis'], 'Redis 持久化')).toBeNull();
  });

  it('只拦完全同名，忽略空格与标点差异', () => {
    expect(findCrossLevelDuplicate(['一致性协议'], '一致性协议')).toBe('一致性协议');
    expect(findCrossLevelDuplicate(['Redis 持久化'], 'Redis持久化')).toBe('Redis 持久化');
  });
});
