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

const REAL_PATHS = ['src/lib/agent.ts', 'src/lib/parse.ts', 'docs/README.md'];
/** 模型爱编的那种路径：文件名是真的，前面整段前缀是想象出来的 */
const MADE_UP_PATH = 'apps/cli/src/lib/agent.ts';

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

const { deleteRepo, readRepoFile } = await import('./repository');

/**
 * 只实现这几个函数用到的 drizzle 链。
 * get 走 repo 行（getRepo），all 走 repo_file 清单（listRepoFilePaths），靠终结方法区分。
 */
function fakeDb(row: FakeRepoRow | null, filePaths: string[] = []) {
  const state = { row, deleteCount: 0 };
  dbRef.current = {
    select: () => ({
      from: () => ({
        where: () => ({
          get: () => state.row,
          all: () => filePaths.map((filePath) => ({ filePath })),
        }),
      }),
    }),
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

/**
 * 回答里的 path:line 是正则扫出来的，模型编的路径照样是可点链接。
 * 点下去必须得到一句人话，而不是带本机绝对路径的 ENOENT。
 */
describe('readRepoFile', () => {
  it('文件真的在就照常读', () => {
    const localPath = makeRepoDir();
    fakeDb({ id: 'r1', localPath }, ['README.md']);

    const res = readRepoFile('r1', 'README.md');

    expect(res.content).toContain('# repo');
    expect(res.totalLines).toBe(1);
  });

  it('路径是编的时候，说清楚没有这个文件并给出相近的真实路径', () => {
    const localPath = makeRepoDir();
    fakeDb({ id: 'r1', localPath }, REAL_PATHS);

    expect(() => readRepoFile('r1', MADE_UP_PATH)).toThrow(
      /仓库里没有这个文件：apps\/cli\/src\/lib\/agent\.ts/,
    );
    expect(() => readRepoFile('r1', MADE_UP_PATH)).toThrow(/- src\/lib\/agent\.ts/);
  });

  it('报错里不出现本机绝对路径，也不出现 ENOENT', () => {
    const localPath = makeRepoDir();
    fakeDb({ id: 'r1', localPath }, REAL_PATHS);

    let message = '';
    try {
      readRepoFile('r1', MADE_UP_PATH);
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).not.toContain(localPath);
    expect(message).not.toContain('ENOENT');
  });

  it('找不到相近路径时不硬凑候选', () => {
    const localPath = makeRepoDir();
    fakeDb({ id: 'r1', localPath }, REAL_PATHS);

    let message = '';
    try {
      readRepoFile('r1', 'server/handler.go');
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain('仓库里没有这个文件：server/handler.go');
    expect(message).not.toContain('相近');
  });

  it('本地目录整个没了时，仍然是「请重新 clone」而不是文件不存在', () => {
    fakeDb({ id: 'r1', localPath: join(tmpdir(), 'openjob-never-existed-42') }, REAL_PATHS);

    expect(() => readRepoFile('r1', 'src/lib/agent.ts')).toThrow(/重新 clone/);
  });
});
