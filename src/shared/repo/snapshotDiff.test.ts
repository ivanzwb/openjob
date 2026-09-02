import { describe, expect, it } from 'vitest';
import { planSnapshotDiff } from './snapshotDiff';

const row = (id: string, path: string, hash: string) => ({ id, path, hash });

describe('planSnapshotDiff', () => {
  it('内容没变的文件一条都不动', () => {
    const plan = planSnapshotDiff(
      [row('1', 'src/a.ts', 'h1'), row('2', 'src/b.ts', 'h2')],
      [
        { path: 'src/a.ts', hash: 'h1' },
        { path: 'src/b.ts', hash: 'h2' },
      ],
    );
    expect(plan).toEqual({ insertPaths: [], updatePaths: [], deleteIds: [], unchanged: 2 });
  });

  it('区分新增/改动/删除', () => {
    const plan = planSnapshotDiff(
      [row('1', 'src/a.ts', 'h1'), row('2', 'src/gone.ts', 'h2'), row('3', 'src/c.ts', 'h3')],
      [
        { path: 'src/a.ts', hash: 'h1-new' },
        { path: 'src/c.ts', hash: 'h3' },
        { path: 'src/new.ts', hash: 'h4' },
      ],
    );
    expect(plan.updatePaths).toEqual(['src/a.ts']);
    expect(plan.insertPaths).toEqual(['src/new.ts']);
    expect(plan.deleteIds).toEqual(['2']);
    expect(plan.unchanged).toBe(1);
  });

  it('首次索引：全是新增', () => {
    const plan = planSnapshotDiff([], [{ path: 'a.ts', hash: 'h' }]);
    expect(plan.insertPaths).toEqual(['a.ts']);
    expect(plan.deleteIds).toEqual([]);
  });

  it('仓库变空：全删，不留孤儿行', () => {
    const plan = planSnapshotDiff([row('1', 'a.ts', 'h')], []);
    expect(plan.deleteIds).toEqual(['1']);
    expect(plan.insertPaths).toEqual([]);
  });

  /**
   * 落库时路径统一走 normalizeRepoPath，比较时也得走，
   * 否则 Windows 上扫出来的 src\a.ts 会跟库里的 src/a.ts 对不上，
   * 每次更新都判成「删一条 + 加一条」，同步量退化回全量。
   */
  it('两侧路径分隔符不一致也认得出是同一个文件', () => {
    const plan = planSnapshotDiff([row('1', 'src/a.ts', 'h1')], [{ path: 'src\\a.ts', hash: 'h1' }]);
    expect(plan).toEqual({ insertPaths: [], updatePaths: [], deleteIds: [], unchanged: 1 });
  });

  it('同一路径重复出现只算一次', () => {
    const plan = planSnapshotDiff(
      [],
      [
        { path: 'a.ts', hash: 'h' },
        { path: './a.ts', hash: 'h' },
      ],
    );
    expect(plan.insertPaths).toEqual(['a.ts']);
  });

  it('接受惰性迭代，不要求先把整仓库读进数组', () => {
    function* incoming(): Generator<{ path: string; hash: string }> {
      yield { path: 'a.ts', hash: 'h1' };
      yield { path: 'b.ts', hash: 'h2' };
    }
    const plan = planSnapshotDiff([row('1', 'a.ts', 'h1')], incoming());
    expect(plan.insertPaths).toEqual(['b.ts']);
    expect(plan.unchanged).toBe(1);
  });
});
