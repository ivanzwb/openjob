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

const { listResumeEntries, updateResumeEntry, duplicateResumeEntry } = await import('./resumeLocal');

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

function fakeDb(options: {
  /** duplicateResumeEntry 复制母版时 getFirstSync 命中的源行 */
  resumes?: {
    id?: string;
    label: string;
    raw_text: string;
    parsed: string | null;
    preview_style: string | null;
    photo: string | null;
  }[];
  /** duplicateResumeEntry 复制优化版时 getFirstSync 命中的源行（同步专用字段） */
  variantSources?: {
    source_resume_id: string | null;
    job_target_id: string;
    label: string;
    content_md: string;
    changelog_md: string | null;
    preview_style: string | null;
    photo: string | null;
    is_user_edited: number;
  }[];
  /** 列表查询（listResumeEntries）返回的形状，带联表别名 */
  variantList?: ReturnType<typeof variantRow>[];
}): {
  db: SQLiteDatabase;
  writes: { sql: string; args: unknown[] }[];
} {
  const writes: { sql: string; args: unknown[] }[] = [];
  const db = {
    getAllSync: (sql: string) => {
      if (sql.includes('FROM resume_variant')) return options.variantList ?? [];
      if (sql.includes('FROM resume')) return (options.resumes ?? []).map((r) => ({ id: r.id ?? 'r1', ...r }));
      throw new Error(`未预期的查询：${sql}`);
    },
    getFirstSync: (sql: string) => {
      if (sql.includes('FROM resume_variant') && options.variantSources?.length) {
        return { id: 'v1', ...options.variantSources[0] };
      }
      if (sql.includes('FROM resume') && options.resumes?.length) {
        return { id: options.resumes[0].id ?? 'r1', ...options.resumes[0] };
      }
      return null;
    },
    runSync: (sql: string, ...args: unknown[]) => {
      writes.push({ sql, args });
    },
  } as unknown as SQLiteDatabase;
  return { db, writes };
}

/** 复制行为：名字加「副本」、正文/模板/寸照/来源关系原样带走、生成新 id 与时间戳 */
describe('duplicateResumeEntry', () => {
  it('复制母版：新 id、label 加「副本」、内容原样', async () => {
    const { db, writes } = fakeDb({
      resumes: [{
        label: '赵伟炳的简历',
        raw_text: '# 简历\n\n- 三年后端',
        parsed: '{"headline":"赵伟炳"}',
        preview_style: '{"a4":{}}',
        photo: 'data:image/png;base64,xx',
      }],
    });
    const newId = await duplicateResumeEntry(db, 'resume', 'r1');

    expect(newId).toBe('uuid-1');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.sql).toContain('INSERT INTO resume');
    expect(writes[0]!.args).toEqual([
      'uuid-1',
      '赵伟炳的简历 副本',
      '# 简历\n\n- 三年后端',
      '{"headline":"赵伟炳"}',
      '{"a4":{}}',
      'data:image/png;base64,xx',
      expect.any(Number),
      expect.any(Number),
    ]);
  });

  it('母版名字为空时回退「简历副本」', async () => {
    const { db, writes } = fakeDb({
      resumes: [{ label: '   ', raw_text: 'x', parsed: null, preview_style: null, photo: null }],
    });
    await duplicateResumeEntry(db, 'resume', 'r1');
    expect(writes[0]!.args[1]).toBe('简历副本');
  });

  it('复制优化版：来源关系、正文、已编辑标记原样带走', async () => {
    const { db, writes } = fakeDb({
      variantSources: [{
        source_resume_id: 'r1',
        job_target_id: 't1',
        label: '乐天 AI 架构师',
        content_md: '# 优化版',
        changelog_md: '改了一版',
        preview_style: '{"a4":{}}',
        photo: null,
        is_user_edited: 1,
      }],
    });
    await duplicateResumeEntry(db, 'variant', 'v1');

    expect(writes).toHaveLength(1);
    expect(writes[0]!.sql).toContain('INSERT INTO resume_variant');
    expect(writes[0]!.args).toEqual([
      'uuid-1',
      'r1',
      't1',
      '乐天 AI 架构师 副本',
      '# 优化版',
      '改了一版',
      '{"a4":{}}',
      null,
      1,
      expect.any(Number),
      expect.any(Number),
    ]);
  });

  it('源不存在时报错且不写库', async () => {
    const { db, writes } = fakeDb({});
    await expect(duplicateResumeEntry(db, 'resume', 'missing')).rejects.toThrow('简历不存在');
    expect(writes).toHaveLength(0);
  });
});

describe('listResumeEntries 优化版命名', () => {
  it('优先显示存储的名称', () => {
    const { db } = fakeDb({ variantList: [variantRow('乐天 AI 架构师（定制版）')] });
    expect(listResumeEntries(db)[0]).toMatchObject({
      label: '乐天 AI 架构师（定制版）',
      headline: '乐天 AI 架构师（定制版）',
    });
  });

  it('名字为空时退回「公司 · 岗位」', () => {
    const { db } = fakeDb({ variantList: [variantRow(null)] });
    expect(listResumeEntries(db)[0]?.label).toBe('乐天 · AI Tech Lead');
  });
});

describe('updateResumeEntry 优化版改名', () => {
  it('改名只写 label，不点亮 is_user_edited', async () => {
    const { db, writes } = fakeDb({});
    await updateResumeEntry(db, 'variant', 'v1', { label: '  新名字  ' });

    expect(writes).toHaveLength(1);
    expect(writes[0]!.sql).toContain('label = ?');
    expect(writes[0]!.sql).not.toContain('is_user_edited');
    expect(writes[0]!.args).toContain('新名字');
  });

  it('空名字按「不改」处理，不写 label', async () => {
    const { db, writes } = fakeDb({});
    await updateResumeEntry(db, 'variant', 'v1', { label: '   ', contentMd: '# 改过正文' });

    expect(writes[0]!.sql).not.toContain('label = ?');
    expect(writes[0]!.sql).toContain('is_user_edited = 1');
  });
});
