/**
 * 优化版简历的改名语义。
 *
 * 优化版过去只能跟着「公司 · 岗位」自动命名，用户改不了；这里钉住改名的三条
 * 约定：名字可以单独改、空串按「不改」处理（清空输入框不该把名字弄丢）、改名
 * 不算「用户改过正文」（那个标记只属于正文/样式/照片被手动动过的情况）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as schema from '../db/schema';

type VariantRow = typeof schema.resumeVariant.$inferSelect;

const dbRef = vi.hoisted(() => ({ current: null as unknown }));
const captured = vi.hoisted(() => ({ patch: null as Record<string, unknown> | null }));

vi.mock('../db', async () => {
  const real = await import('../db/schema');
  return { getDb: () => dbRef.current, schema: real };
});

// 依赖 electron 侧配置/优先级计算，改名的用例不需要它们
vi.mock('../diagnosis/priority', () => ({
  computePriority: () => ({ score: 1 }),
  attachPriorityReason: (node: unknown) => node,
}));

const { updateResumeVariant } = await import('./variantRepository');

const baseRow: VariantRow = {
  id: 'v1',
  sourceResumeId: 'r1',
  jobTargetId: 't1',
  label: '乐天 · AI Tech Lead',
  contentMd: '# 简历',
  changelogMd: '',
  previewStyle: null,
  photo: null,
  isUserEdited: false,
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  const state = { row: { ...baseRow } };
  captured.patch = null;
  dbRef.current = {
    select: () => ({
      from: () => ({
        where: () => ({
          get: () => state.row,
          all: () => [state.row],
        }),
        orderBy: () => ({ all: () => [state.row] }),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        captured.patch = patch;
        Object.assign(state.row, patch);
        return { where: () => ({ run: () => undefined }) };
      },
    }),
  };
});

describe('updateResumeVariant 改名', () => {
  it('可以单独改名字，且改名不点亮「用户改过正文」', () => {
    const view = updateResumeVariant({ id: 'v1', label: '  乐天 AI 架构师（定制版）  ' });

    expect(captured.patch?.label).toBe('乐天 AI 架构师（定制版）');
    expect(captured.patch?.isUserEdited).toBe(false);
    expect(view.label).toBe('乐天 AI 架构师（定制版）');
  });

  it('清空名字按「不改」处理，保留原名', () => {
    updateResumeVariant({ id: 'v1', label: '   ' });
    expect(captured.patch?.label).toBe('乐天 · AI Tech Lead');
  });

  it('不传 label 时名字不动', () => {
    updateResumeVariant({ id: 'v1', contentMd: '# 新正文' });
    expect(captured.patch?.label).toBe('乐天 · AI Tech Lead');
    expect(captured.patch?.isUserEdited).toBe(true);
  });
});
