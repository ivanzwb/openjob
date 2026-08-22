import { describe, expect, it } from 'vitest';
import type { GeneratedNode } from './prompts';
import { flattenGeneratedTree } from './tree';

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
