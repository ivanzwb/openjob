/**
 * 名字可改：优化版列表优先显示存储名称、改名写入不点亮「用户改过正文」、
 * 空串按「不改」处理。
 */
import { describe, expect, it, vi } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';

vi.mock('expo-crypto', () => ({ randomUUID: () => 'uuid-1' }));
vi.mock('../sync/identity', () => ({ getDeviceIdentity: async () => ({ deviceId: 'd1' }) }));
vi.mock('../sync/triggers', () => ({ writingAs: (_db: unknown, _id: string, fn: () => void) => fn() }));
// 本用例只钉本地读写映射；AI 归类走网络与 RN 运行时，测试里整段替换
vi.mock('./resumeAi', () => ({ structureResume: async () => ({ contentMd: '' }) }));

const { listResumeEntries, updateResumeEntry } = await import('./resumeLocal');

const variantRow = (label: string | null) => ({
  id: 'v1',
  label,
  content_md: '# 简历',
  preview_style: null,
  photo: null,
  updated_at: 2,
  company: '乐天',
  role_title: 'AI Tech Lead',
  source_label: '赵伟炳的简历',
});

function fakeDb(variants: ReturnType<typeof variantRow>[]): {
  db: SQLiteDatabase;
  writes: Array<{ sql: string; args: unknown[] }>;
} {
  const writes: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    getAllSync: (sql: string) => {
      if (sql.includes('FROM resume_variant')) return variants;
      if (sql.includes('FROM resume')) return [];
      throw new Error(`未预期的查询：${sql}`);
    },
    runSync: (sql: string, ...args: unknown[]) => {
      writes.push({ sql, args });
    },
  } as unknown as SQLiteDatabase;
  return { db, writes };
}

describe('listResumeEntries 优化版命名', () => {
  it('优先显示存储的名称', () => {
    const { db } = fakeDb([variantRow('乐天 AI 架构师（定制版）')]);
    expect(listResumeEntries(db)[0]).toMatchObject({
      label: '乐天 AI 架构师（定制版）',
      headline: '乐天 AI 架构师（定制版）',
    });
  });

  it('名字为空时退回「公司 · 岗位」', () => {
    const { db } = fakeDb([variantRow(null)]);
    expect(listResumeEntries(db)[0]?.label).toBe('乐天 · AI Tech Lead');
  });
});

describe('updateResumeEntry 优化版改名', () => {
  it('改名只写 label，不点亮 is_user_edited', async () => {
    const { db, writes } = fakeDb([]);
    await updateResumeEntry(db, 'variant', 'v1', { label: '  新名字  ' });

    expect(writes).toHaveLength(1);
    expect(writes[0]!.sql).toContain('label = ?');
    expect(writes[0]!.sql).not.toContain('is_user_edited');
    expect(writes[0]!.args).toContain('新名字');
  });

  it('空名字按「不改」处理，不写 label', async () => {
    const { db, writes } = fakeDb([]);
    await updateResumeEntry(db, 'variant', 'v1', { label: '   ', contentMd: '# 改过正文' });

    expect(writes[0]!.sql).not.toContain('label = ?');
    expect(writes[0]!.sql).toContain('is_user_edited = 1');
  });
});
