import { describe, expect, it } from 'vitest';
import type { EdgeRelation } from '@shared/enums';
import { sortNodesByStudyOrder, topoSortByPrerequisite } from './studyOrder';

interface TestNode {
  id: string;
  difficulty: number;
  priorityScore: number;
}

function node(id: string, difficulty: number, priorityScore: number): TestNode {
  return { id, difficulty, priorityScore };
}

function edge(fromNodeId: string, toNodeId: string, relation: EdgeRelation = 'prerequisite') {
  return { fromNodeId, toNodeId, relation };
}

describe('sortNodesByStudyOrder', () => {
  it('先按难度升序，同难度按优先级降序', () => {
    const nodes = [node('a', 3, 10), node('b', 1, 10), node('c', 1, 90)];

    expect(sortNodesByStudyOrder(nodes, []).map((n) => n.id)).toEqual(['c', 'b', 'a']);
  });

  it('前置考点排到依赖它的考点之前，哪怕难度更高', () => {
    const nodes = [node('easy', 1, 50), node('hard', 5, 50)];
    const sorted = sortNodesByStudyOrder(nodes, [edge('hard', 'easy')]);

    expect(sorted.map((n) => n.id)).toEqual(['hard', 'easy']);
  });

  it('只有 prerequisite 参与拓扑重排，related 不影响顺序', () => {
    const nodes = [node('a', 1, 50), node('b', 5, 50)];

    expect(sortNodesByStudyOrder(nodes, [edge('b', 'a', 'related')]).map((n) => n.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('难度和优先级都并列时按 id 定序，输入行序不影响结果', () => {
    // 这是两端顺序一致的关键：难度、优先级并列时若不再收尾，结果就取决于
    // 各自数据库返回的行序，而两端的行序本来就不同。
    const nodes = [node('n3', 2, 50), node('n1', 2, 50), node('n2', 2, 50)];

    expect(sortNodesByStudyOrder(nodes, []).map((n) => n.id)).toEqual(['n1', 'n2', 'n3']);
  });

  it('同一批考点无论行序如何都排成同一个样子（两端一致）', () => {
    const nodes = [
      node('d4', 2, 50),
      node('a1', 1, 50),
      node('c3', 2, 50),
      node('b2', 1, 80),
      node('e5', 3, 10),
    ];
    const edges = [edge('c3', 'e5')];

    const desktopRowOrder = sortNodesByStudyOrder(nodes, edges).map((n) => n.id);
    const mobileRowOrder = sortNodesByStudyOrder([...nodes].reverse(), edges).map((n) => n.id);
    const shuffled = sortNodesByStudyOrder(
      [nodes[2], nodes[4], nodes[0], nodes[3], nodes[1]],
      edges,
    ).map((n) => n.id);

    expect(mobileRowOrder).toEqual(desktopRowOrder);
    expect(shuffled).toEqual(desktopRowOrder);
  });

  it('不修改传入的数组', () => {
    const nodes = [node('b', 5, 1), node('a', 1, 1)];
    sortNodesByStudyOrder(nodes, []);

    expect(nodes.map((n) => n.id)).toEqual(['b', 'a']);
  });
});

describe('topoSortByPrerequisite', () => {
  it('成环时不丢节点，环内成员按原顺序兜底输出', () => {
    const nodes = [node('a', 1, 1), node('b', 1, 1), node('c', 1, 1)];
    const sorted = topoSortByPrerequisite(nodes, [edge('a', 'b'), edge('b', 'a')]);

    expect(sorted.map((n) => n.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('指向集合外节点的边被忽略', () => {
    const nodes = [node('a', 1, 1), node('b', 1, 1)];
    const sorted = topoSortByPrerequisite(nodes, [edge('outside', 'a')]);

    expect(sorted.map((n) => n.id)).toEqual(['a', 'b']);
  });
});
