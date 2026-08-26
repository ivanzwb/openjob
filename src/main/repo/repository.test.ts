/**
 * deleteRepo 的兜底语义：本地目录删不掉也要让条目走掉。
 *
 * 反过来（删不掉就不删条目）会把仓库永久钉在列表里——同一个目录每次都删不掉，
 * 用户重试多少次都是同一个错。这几条用例守的就是这个顺序。
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RemoveDirModule from './removeDir';
import { removeDirTree } from './removeDir';

interface FakeRepoRow {
  id: string;
  localPath: string;
}

const dbRef = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../db', async () => {
  // schema 只依赖 drizzle 的表定义，可以直接用真的；getDb 才需要换掉（它会连库、拉 electron）
  const schema = await import('../db/schema');
  return { getDb: () => dbRef.current, schema };
});
vi.mock('../paths', () => ({ getAppPaths: () => ({ reposDir: tmpdir() }) }));
vi.mock('../ipc/bridge', () => ({ emit: () => undefined }));
vi.mock('../llm/json', () => ({ completeJson: () => Promise.resolve({}) }));
vi.mock('./removeDir', async (importOriginal) => {
  const actual = await importOriginal<typeof RemoveDirModule>();
  return { removeDirTree: vi.fn(actual.removeDirTree) };
});

const { deleteRepo } = await import('./repository');

/** 只实现 deleteRepo 用到的那两条 drizzle 链 */
function fakeDb(row: FakeRepoRow | null) {
  const state = { row, deleteCount: 0 };
  dbRef.current = {
    select: () => ({ from: () => ({ where: () => ({ get: () => state.row }) }) }),
    delete: () => ({
      where: () => ({
        run: () => {
          state.deleteCount++;
          state.row = null;
        },
      }),
    }),
  };
  return state;
}

const created: string[] = [];

function makeRepoDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'openjob-delrepo-'));
  created.push(root);
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# repo');
  return root;
}

beforeEach(() => {
  vi.mocked(removeDirTree).mockClear();
});

afterEach(() => {
  for (const root of created.splice(0)) {
    try {
      removeDirTree(root);
    } catch {
      // 清理失败不该把测试结果盖掉
    }
  }
});

describe('deleteRepo', () => {
  it('目录删不掉时照样删数据库行，并带回残留路径', () => {
    const localPath = makeRepoDir();
    const state = fakeDb({ id: 'r1', localPath });
    vi.mocked(removeDirTree).mockImplementationOnce(() => {
      throw Object.assign(
        new Error(`EPERM: operation not permitted, rmdir '${localPath}'`),
        { code: 'EPERM' },
      );
    });

    const result = deleteRepo('r1');

    expect(state.deleteCount).toBe(1);
    expect(result.leftoverPath).toBe(localPath);
    expect(result.reason).toContain('EPERM');
    // 目录确实还在，提示用户手删不是空话
    expect(existsSync(localPath)).toBe(true);
  });

  it('正常删除时残留路径为 null', () => {
    const localPath = makeRepoDir();
    const state = fakeDb({ id: 'r1', localPath });

    const result = deleteRepo('r1');

    expect(state.deleteCount).toBe(1);
    expect(result).toEqual({ leftoverPath: null, reason: null });
    expect(existsSync(localPath)).toBe(false);
  });

  it('本地目录本来就不存在时直接删行', () => {
    const state = fakeDb({ id: 'r1', localPath: join(tmpdir(), 'openjob-never-existed-42') });

    const result = deleteRepo('r1');

    expect(state.deleteCount).toBe(1);
    expect(result.leftoverPath).toBeNull();
    expect(vi.mocked(removeDirTree)).not.toHaveBeenCalled();
  });

  it('仓库不存在时什么都不删', () => {
    const state = fakeDb(null);

    const result = deleteRepo('missing');

    expect(state.deleteCount).toBe(0);
    expect(result).toEqual({ leftoverPath: null, reason: null });
  });
});
