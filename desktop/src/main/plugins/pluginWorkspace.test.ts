/**
 * 工作区原语的边界（分发计划 §11.3 阶段 1 验收原文）：路径越界、未授权、上限三类。
 *
 * 这三类里最核心的是路径越界——原语的意义就在于「包拿到的路径解析后一定落在本包目录内」。
 * 所以绝对路径、`..` 逸出、经符号链接逸出各有一条用例。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = { userData: '' };

// pluginWorkspace.ts 的根目录解析走 electron 的 app.getPath('userData')；测试里给个临时目录
vi.mock('electron', () => ({ app: { getPath: () => state.userData } }));

import type { PluginPermissionGateway } from './permissionGateway';
import {
  WORKSPACE_LIMITS,
  WorkspaceAccessDeniedError,
  WorkspaceError,
  createWorkspaceFileSystem,
  pluginWorkspaceRoot,
  workspaceGlob,
  workspaceRead,
  workspaceWrite,
} from './pluginWorkspace';

const ALLOW: PluginPermissionGateway = {
  authorizePlugin: () => ({ allowed: true, pluginId: 'demo.pack', permission: 'filesystem:workspace' }),
};
const DENY: PluginPermissionGateway = {
  authorizePlugin: () => ({
    allowed: false,
    code: 'permission-undeclared',
    message: 'Capability did not declare the requested permission.',
  }),
};

let root: string;

beforeEach(() => {
  state.userData = mkdtempSync(join(tmpdir(), 'openjob-ws-userdata-'));
  root = mkdtempSync(join(tmpdir(), 'openjob-ws-root-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(state.userData, { recursive: true, force: true });
});

/** 跑一次调用并取回它抛出的 WorkspaceError.code；没抛就失败。 */
function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof WorkspaceError) return error.code;
    throw error;
  }
  throw new Error('期望抛错，但调用成功返回了');
}

describe('路径越界即拒', () => {
  it('绝对路径直接拒（不把调用方给的绝对路径当成本包内的路径）', () => {
    expect(codeOf(() => createWorkspaceFileSystem(root).read(join(root, 'a.txt')))).toBe(
      'path-absolute',
    );
  });

  it('`..` 逸出拒（相对路径也不许跳出本包目录）', () => {
    const outside = join(root, '..', `openjob-outside-${process.pid}.txt`);
    writeFileSync(outside, 'secret');
    try {
      const fs = createWorkspaceFileSystem(root);
      expect(codeOf(() => fs.read('../' + `openjob-outside-${process.pid}.txt`))).toBe(
        'path-escape',
      );
      expect(codeOf(() => fs.read('nested/../../' + `openjob-outside-${process.pid}.txt`))).toBe(
        'path-escape',
      );
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('经符号链接逸出拒，遍历也不跟随链接', () => {
    const outside = mkdtempSync(join(tmpdir(), 'openjob-ws-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'top secret');
    let linked = false;
    try {
      symlinkSync(outside, join(root, 'link'), 'junction');
      linked = true;
    } catch {
      try {
        symlinkSync(outside, join(root, 'link'), 'dir');
        linked = true;
      } catch {
        // 平台不支持创建符号链接，下面按「未链接」处理
      }
    }
    try {
      if (!linked) return; // 平台不支持创建符号链接，跳过（不假装通过）
      const fs = createWorkspaceFileSystem(root);
      expect(codeOf(() => fs.read('link/secret.txt'))).toBe('path-symlink-escape');
      // glob / list 不跟随链接，就不会把外部文件暴露出来
      expect(fs.glob('**/*.txt')).not.toContain('link/secret.txt');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('未授权即拒', () => {
  it('未声明 filesystem:workspace 时读被拒，且不触碰文件系统', () => {
    writeFileSync(join(root, 'a.txt'), 'hello');
    let error: unknown;
    try {
      workspaceRead('demo.pack', { path: 'a.txt' }, { permissionGateway: DENY, root });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WorkspaceAccessDeniedError);
    // 拒绝理由不带出任何调用方给的路径或本机根目录
    expect((error as Error).message).not.toContain(root);
    expect((error as Error).message).not.toContain('a.txt');
  });

  it('未授权时写不落盘（拒绝发生在任何文件操作之前）', () => {
    expect(() =>
      workspaceWrite('demo.pack', { path: 'created.txt', content: 'x' }, {
        permissionGateway: DENY,
        root,
      }),
    ).toThrowError(WorkspaceAccessDeniedError);
    expect(existsSync(join(root, 'created.txt'))).toBe(false);
  });
});

describe('超限即报错（不静默截断）', () => {
  it('单次读超过上限报错', () => {
    writeFileSync(join(root, 'big.txt'), 'a'.repeat(WORKSPACE_LIMITS.readBytes + 1));
    expect(codeOf(() => createWorkspaceFileSystem(root).read('big.txt'))).toBe('read-limit');
  });

  it('单次写超过上限报错，且不落盘', () => {
    const fs = createWorkspaceFileSystem(root);
    expect(codeOf(() => fs.write('big.txt', 'a'.repeat(WORKSPACE_LIMITS.writeBytes + 1)))).toBe(
      'write-limit',
    );
    expect(existsSync(join(root, 'big.txt'))).toBe(false);
  });

  it('glob 结果数超过上限报错', () => {
    for (let index = 0; index <= WORKSPACE_LIMITS.globResults; index += 1) {
      writeFileSync(join(root, `f${index}.md`), 'x');
    }
    expect(codeOf(() => createWorkspaceFileSystem(root).glob('*.md'))).toBe('glob-limit');
  });

  it('grep 命中数超过上限报错', () => {
    const lines = Array.from({ length: WORKSPACE_LIMITS.grepMatches + 1 }, () => 'hit');
    writeFileSync(join(root, 'hits.txt'), lines.join('\n'));
    expect(codeOf(() => createWorkspaceFileSystem(root).grep('hit'))).toBe('grep-limit');
  });
});

describe('本包工作区目录', () => {
  it('位置与命名与 ctx.storage 同一套约定，一个包一块', () => {
    expect(pluginWorkspaceRoot('demo.pack').endsWith(join('plugin-workspace', 'demo.pack'))).toBe(
      true,
    );
    expect(codeOf(() => pluginWorkspaceRoot('../escape'))).toBe('invalid-input');
  });
});

describe('基本语义', () => {
  it('写 / 读（含行范围）/ 快照 / 遍历 / glob / grep / 删', () => {
    const fs = createWorkspaceFileSystem(root);
    fs.write('src/a.ts', 'line1\nline2\nline3\n');
    mkdirSync(join(root, 'src'), { recursive: true });
    fs.write('src/b.ts', 'const hit = 1;\n');

    expect(fs.read('src/a.ts')).toBe('line1\nline2\nline3\n');
    expect(fs.read('src/a.ts', { startLine: 2, endLine: 2 })).toBe('line2');

    const snap = fs.snapshot('src/a.ts');
    expect(snap?.bytes).toBeGreaterThan(0);
    expect(snap?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.snapshot('missing.ts')).toBeNull();

    expect(fs.glob('**/*.ts').sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(fs.list('src').map((entry) => entry.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);

    const hits = fs.grep('hit');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ path: 'src/b.ts', line: 1 });

    fs.delete('src/b.ts');
    expect(existsSync(join(root, 'src', 'b.ts'))).toBe(false);
  });

  it('授权时服务层把调用透传到本包工作区（经网关一次）', () => {
    expect(() =>
      workspaceWrite('demo.pack', { path: 'note.txt', content: 'ok' }, {
        permissionGateway: ALLOW,
        root,
      }),
    ).not.toThrow();
    expect(workspaceRead('demo.pack', { path: 'note.txt' }, { permissionGateway: ALLOW, root })).toBe(
      'ok',
    );
    expect(workspaceGlob('demo.pack', { pattern: '*.txt' }, { permissionGateway: ALLOW, root })).toEqual([
      'note.txt',
    ]);
  });
});
