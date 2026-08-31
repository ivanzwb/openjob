/**
 * 守「考点树只有三层」这条线。
 *
 * 桌面端一直是靠 UI 隐藏按钮把细化限制在 domain/topic 上，手机端两个按钮都
 * 没有判断，于是 point 可以被反复细化，层级不封顶。深度不封顶不只是清单变长：
 * 排程把所有非 domain 节点都当可排期单元，细化不是把父节点拆开而是在它自己
 * 那条任务之外再加 3-6 条，每多一层乘 3-6，默认 90 分钟/天的预算撑不住。
 *
 * 判断现在下沉到后端（细化有三个入口：桌面 UI、手机 UI、sync/rpc），这里守的
 * 就是后端那道门：撞线要在花掉模型调用之前就报错。
 */
import { describe, expect, it, vi } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import { EXPAND_DEPTH_LIMIT_MESSAGE, canExpandNode } from '@shared/diagnosis/tree';

const completeJson = vi.hoisted(() => vi.fn());
vi.mock('../llm/json', () => ({ completeJson }));
// 被测路径一步都走不到这些，但它们在模块顶层就把 react-native 拉进来，vitest 解析不了
vi.mock('expo-crypto', () => ({ randomUUID: () => 'generated-id' }));
vi.mock('expo-secure-store', () => ({}));
vi.mock('../search', () => ({ searchWeb: vi.fn() }));

const { diagnoseExpandNode } = await import('./diagnosisLocal');
const { createKnowledgeChild } = await import('./nodesLocal');

/** 只实现被测路径用到的查询，其余撞上就报错，免得静默返回 null 把断言蒙过去 */
function dbWithNode(kind: string): SQLiteDatabase {
  return {
    getFirstSync: (sql: string) => {
      if (sql.includes('knowledge_node')) {
        return { id: 'n1', campaign_id: 'c1', name: '考点', kind, coverage_type: 'gap' };
      }
      throw new Error(`未预期的查询：${sql}`);
    },
  } as unknown as SQLiteDatabase;
}

describe('考点细化的层级上限', () => {
  it('domain 和 topic 可以细化，point 不行', () => {
    expect(canExpandNode('domain')).toBe(true);
    expect(canExpandNode('topic')).toBe(true);
    expect(canExpandNode('point')).toBe(false);
  });

  it('细化 point 直接报错，而且不花模型调用', async () => {
    completeJson.mockClear();

    await expect(diagnoseExpandNode(dbWithNode('point'), 'n1')).rejects.toThrow(
      EXPAND_DEPTH_LIMIT_MESSAGE,
    );
    // 拦截必须在请求之前：撞线还去问一次模型，等于每次点击都白烧一次调用
    expect(completeJson).not.toHaveBeenCalled();
  });

  it('给 point 加子考点也要被拦住', async () => {
    await expect(createKnowledgeChild(dbWithNode('point'), 'n1', '更细的点')).rejects.toThrow(
      EXPAND_DEPTH_LIMIT_MESSAGE,
    );
  });
});
