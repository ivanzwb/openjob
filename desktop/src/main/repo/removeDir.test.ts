import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeDirTree } from './removeDir';

const created: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openjob-rmdir-'));
  created.push(root);
  return root;
}

afterEach(() => {
  // 只读属性留着会让下一轮测试和 CI 清理都卡住
  for (const root of created.splice(0)) {
    try {
      removeDirTree(root);
    } catch {
      // 清理失败不该把测试结果盖掉
    }
  }
});

describe('removeDirTree', () => {
  it('删掉含只读文件的目录树', () => {
    // git 的 .git/objects 就是这个形状：目录可写，里面的对象文件只读
    const root = makeTempRoot();
    const objects = join(root, '.git', 'objects', 'ab');
    mkdirSync(objects, { recursive: true });

    const loose = join(objects, 'cdef1234');
    writeFileSync(loose, 'object');
    chmodSync(loose, 0o444);
    expect(statSync(loose).mode & 0o200).toBe(0);

    removeDirTree(root);
    expect(existsSync(root)).toBe(false);
  });

  it('删掉含只读子目录的目录树', () => {
    // 子目录不可写时，POSIX 上连它的子文件都 unlink 不掉
    const root = makeTempRoot();
    const locked = join(root, 'locked');
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, 'inner.txt'), 'inner');
    chmodSync(locked, 0o500);

    removeDirTree(root);
    expect(existsSync(root)).toBe(false);
  });

  it('嵌套多层的只读文件也要清干净', () => {
    const root = makeTempRoot();
    const deep = join(root, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    for (const [i, dir] of [join(root, 'a'), join(root, 'a', 'b'), deep].entries()) {
      const file = join(dir, `f${i}.pack`);
      writeFileSync(file, 'pack');
      chmodSync(file, 0o444);
    }

    removeDirTree(root);
    expect(existsSync(root)).toBe(false);
  });

  it('路径不存在时静默返回', () => {
    const root = makeTempRoot();
    const missing = join(root, 'never-existed');

    expect(() => removeDirTree(missing)).not.toThrow();
  });

  it('只读文件本身不会让 rmSync 失败——别再把 EPERM 归因到它', () => {
    // 「git 的对象文件是只读的，所以删不掉」听起来很合理，实际是错的：
    // Node 的 rm 内部对 Windows 的 EPERM 已经会 chmod 后重试。这条断言把
    // 这个事实钉住，省得下次又有人顺着只读属性去查一遍。
    //
    // 真正删不掉的原因是别的进程占着句柄（杀毒扫描、资源管理器开着该目录、
    // 编辑器、正在跑的索引），那种 EPERM 只能靠重试和明确报错来应对。
    const root = makeTempRoot();
    mkdirSync(join(root, 'objects'), { recursive: true });
    const loose = join(root, 'objects', 'cdef1234');
    writeFileSync(loose, 'object');
    chmodSync(loose, 0o444);

    expect(() => rmSync(root, { recursive: true, force: true })).not.toThrow();
    expect(existsSync(root)).toBe(false);
  });
});
