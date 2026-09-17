/**
 * 远端拉取的策略边界（分发计划 §11.2 工作区原语的最后一行）。
 *
 * 这一组用例的重心是**策略**而不是 git 本身：放行哪些地址、argv 长什么样、目录被占用时怎么办、
 * 失败与超限有没有留下残骸。真正的 git 调用用注入的 runner 替掉，所以用例不联网、不依赖网络。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitRunResult } from './git';
import {
  buildCloneArgv,
  buildUpdateArgvs,
  deriveDirName,
  measureDir,
  normalizeRepoUrl,
  runFetch,
  validateFetchUrl,
  type GitRunner,
} from './gitFetch';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openjob-fetch-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ok = (stdout = ''): GitRunResult => ({ code: 0, stdout, stderr: '', timedOut: false });
const bad = (stderr = 'boom'): GitRunResult => ({ code: 128, stdout: '', stderr, timedOut: false });

/** 记录每条命令并给出可编排的回答 */
function recordingRunner(answers: ((args: readonly string[]) => GitRunResult)[]): {
  run: GitRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args) => {
      calls.push([...args]);
      const answer = answers.shift();
      return answer ? answer(args) : ok();
    },
  };
}

describe('只放行公开的 https 仓库地址', () => {
  it('正常的公开仓库地址通过', () => {
    expect(validateFetchUrl('https://github.com/org/repo.git')).toEqual({
      ok: true,
      url: 'https://github.com/org/repo.git',
    });
  });

  it('其它传输方式一律拒：ext:: 能执行命令，file:// 与本地路径能读本机', () => {
    for (const raw of [
      'ext::sh -c whoami',
      'file:///etc/passwd',
      'git://github.com/org/repo.git',
      'ssh://git@github.com/org/repo.git',
      'http://github.com/org/repo.git',
      '/tmp/somewhere',
      'C:\\repos\\mine',
      'github.com/org/repo',
    ]) {
      expect(validateFetchUrl(raw).ok, raw).toBe(false);
    }
  });

  it('带用户名密码的地址拒（插件的拉取不该知道用户的凭据）', () => {
    const checked = validateFetchUrl('https://user:pw@github.com/org/repo.git');
    expect(checked.ok).toBe(false);
  });

  it('回环与内网地址拒（否则包能拿用户的机器当跳板探内网）', () => {
    for (const raw of [
      'https://localhost/x/y',
      'https://127.0.0.1/x/y',
      'https://192.168.1.1/x/y',
      'https://10.0.0.5/x/y',
      'https://172.16.3.4/x/y',
      'https://169.254.1.1/x/y',
      'https://[::1]/x/y',
      'https://router.local/x/y',
      'https://vault.internal/x/y',
    ]) {
      expect(validateFetchUrl(raw).ok, raw).toBe(false);
    }
    // 公网 IP 字面量不算内网
    expect(validateFetchUrl('https://8.8.8.8/x/y').ok).toBe(true);
  });

  it('空白、控制字符、超长、缺路径的地址拒', () => {
    expect(validateFetchUrl('').ok).toBe(false);
    expect(validateFetchUrl('https://github.com/a b/c').ok).toBe(false);
    expect(validateFetchUrl(`https://github.com/${'a'.repeat(3000)}`).ok).toBe(false);
    expect(validateFetchUrl('https://github.com/').ok).toBe(false);
  });
});

describe('argv 固定，不给包拼选项的机会', () => {
  it('clone：深度 1、单分支、不要 tags，`--` 之后才是 url 与目录', () => {
    const argv = buildCloneArgv('https://github.com/org/repo.git', '/ws/org-repo');
    expect(argv.slice(0, 6)).toEqual(['clone', '--depth', '1', '--single-branch', '--no-tags', '--quiet']);
    expect(argv[argv.length - 2]).toBe('https://github.com/org/repo.git');
    expect(argv[argv.length - 1]).toBe('/ws/org-repo');
    expect(argv).toContain('--');
    expect(argv.indexOf('--')).toBe(argv.length - 3);
  });

  it('更新：先 fetch 再硬重置到 FETCH_HEAD（不 pull，避免把合并冲突丢给包）', () => {
    expect(buildUpdateArgvs('/ws/org-repo')).toEqual([
      ['-C', '/ws/org-repo', 'fetch', '--depth', '1', '--no-tags', 'origin', 'HEAD'],
      ['-C', '/ws/org-repo', 'reset', '--hard', 'FETCH_HEAD'],
    ]);
  });
});

describe('目录名由地址推导时不可能越界', () => {
  it('取路径最后两段做 slug', () => {
    expect(deriveDirName('https://github.com/org/repo.git')).toBe('org-repo');
    expect(deriveDirName('https://github.com/org/repo')).toBe('org-repo');
    expect(deriveDirName('https://gitlab.com/group/sub/repo.git')).toBe('sub-repo');
  });

  it('`..`、绝对路径、奇怪字符都被抹成安全 slug', () => {
    expect(deriveDirName('https://github.com/../../etc/passwd')).toBe('etc-passwd');
    expect(deriveDirName('https://github.com/%2e%2e/%2e%2e')).toBe('checkout');
    expect(deriveDirName('not-a-url')).toBe('checkout');
    expect(deriveDirName(`https://github.com/org/${'x'.repeat(200)}`).length).toBeLessThanOrEqual(64);

    // 不猜具体串：任何输入都只可能产出 [a-z0-9._-]，且不可能是 `.` / `..`
    for (const hostile of [
      'https://github.com/org/re po!@#$.git',
      'https://github.com/org/..%2f..%2fetc%2fpasswd',
      'https://github.com/org/%00%2e%2e',
      'https://github.com/org/.',
      'https://github.com/org/..',
      'https://github.com/',
    ]) {
      const slug = deriveDirName(hostile);
      expect(slug, hostile).toMatch(/^[a-z0-9._-]+$/);
      expect(slug === '.' || slug === '..', hostile).toBe(false);
    }
  });
});

describe('体积与文件数统计', () => {
  it('累计体积与文件数，不跟随符号链接', () => {
    writeFileSync(join(root, 'a.txt'), 'abcdef');
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', 'b.txt'), 'abcdefghij');

    const linked = join(root, 'link');
    let linkedOk = false;
    try {
      symlinkSync(process.platform === 'win32' ? 'C:\\' : '/', linked, 'dir');
      linkedOk = true;
    } catch {
      // 平台不允许建链接就跳过这一条断言
    }

    const measured = measureDir(root);
    expect(measured.bytes).toBe(16);
    expect(measured.fileCount).toBe(2);
    expect(measured.exceeded).toBeNull();
    if (linkedOk) expect(existsSync(linked)).toBe(true);
  });

  it('超过上限时提前收工并标出是哪一项', () => {
    writeFileSync(join(root, 'a.txt'), 'abcdefghij');
    writeFileSync(join(root, 'b.txt'), 'abcdefghij');

    expect(measureDir(root, { maxBytes: 5, maxFiles: 100 }).exceeded).toBe('bytes');
    expect(measureDir(root, { maxBytes: 1000, maxFiles: 1 }).exceeded).toBe('files');
  });
});

describe('拉取流程', () => {
  it('新目录走 clone：按顺序跑 clone、rev-parse', async () => {
    const target = join(root, 'org-repo');
    const { run, calls } = recordingRunner([
      (args) => {
        // clone 的副作用由 runner 制造：真的建出检出目录
        expect(args[0]).toBe('clone');
        mkdirSync(String(args.at(-1)), { recursive: true });
        writeFileSync(join(String(args.at(-1)), 'index.ts'), 'export const x = 1;');
        return ok();
      },
      () => ok('deadbeef'),
      () => ok('main'),
    ]);

    const result = await runFetch({ url: 'https://github.com/org/repo.git', dir: target }, run);

    expect(result).toMatchObject({
      ok: true,
      outcome: { mode: 'clone', commit: 'deadbeef', branch: 'main', fileCount: 1 },
    });
    expect(calls[0]![0]).toBe('clone');
    expect(calls[1]).toEqual(['-C', target, 'rev-parse', 'HEAD']);
    expect(calls[2]).toEqual(['-C', target, 'rev-parse', '--abbrev-ref', 'HEAD']);
  });

  it('clone 失败：把半成品目录删掉，错误里不出现本机路径', async () => {
    const target = join(root, 'org-repo');
    const { run } = recordingRunner([
      (args) => {
        mkdirSync(String(args.at(-1)), { recursive: true });
        return bad(`fatal: could not read from ${target}`);
      },
    ]);

    const result = await runFetch({ url: 'https://github.com/org/repo.git', dir: target }, run);

    expect(result).toMatchObject({ ok: false, code: 'failed' });
    if (!result.ok) expect(result.detail).not.toContain(root);
    expect(existsSync(target)).toBe(false);
  });

  it('已有检出：origin 一致就去更新，不一致就拒（不许两个仓库指同一个目录）', async () => {
    const target = join(root, 'org-repo');
    mkdirSync(join(target, '.git'), { recursive: true });

    const same = recordingRunner([() => ok('https://github.com/org/repo.git'), () => ok(), () => ok(), () => ok('aaa'), () => ok('main')]);
    const updated = await runFetch({ url: 'https://github.com/org/repo.git', dir: target }, same.run);
    expect(updated).toMatchObject({ ok: true, outcome: { mode: 'update' } });
    expect(same.calls[1]).toEqual(['-C', target, 'fetch', '--depth', '1', '--no-tags', 'origin', 'HEAD']);
    expect(same.calls[2]).toEqual(['-C', target, 'reset', '--hard', 'FETCH_HEAD']);

    const other = recordingRunner([() => ok('https://github.com/other/thing.git')]);
    const refused = await runFetch({ url: 'https://github.com/org/repo.git', dir: target }, other.run);
    expect(refused).toMatchObject({ ok: false, code: 'origin-mismatch' });
    expect(other.calls).toHaveLength(1);
  });

  it('目录非空且不是检出：拒，而且一条 git 命令都不跑（不覆盖包自己的数据）', async () => {
    const target = join(root, 'data');
    mkdirSync(target);
    writeFileSync(join(target, 'repos.json'), '[]');

    const { run, calls } = recordingRunner([]);
    const result = await runFetch({ url: 'https://github.com/org/repo.git', dir: target }, run);

    expect(result).toMatchObject({ ok: false, code: 'dir-occupied' });
    expect(calls).toEqual([]);
    expect(existsSync(join(target, 'repos.json'))).toBe(true);
  });

  it('超限：清理掉拉下来的内容，不让它留在工作区里', async () => {
    const target = join(root, 'org-repo');
    const { run } = recordingRunner([
      (args) => {
        mkdirSync(String(args.at(-1)), { recursive: true });
        writeFileSync(join(String(args.at(-1)), 'big.bin'), 'x'.repeat(4096));
        return ok();
      },
      () => ok('deadbeef'),
      () => ok('main'),
    ]);

    // 真实上限是 512 MB，这里借 measureDir 的可注入上限把「超限」这条路径跑出来
    const result = await runFetch({ url: 'https://github.com/org/repo.git', dir: target }, run, {
      maxBytes: 16,
      maxFiles: 100,
    });

    expect(result).toMatchObject({ ok: false, code: 'limit-exceeded' });
    expect(existsSync(target)).toBe(false);
  });

  it('超时被掐断时给出的原因是超时，而不是 git 的退出码', async () => {
    const target = join(root, 'org-repo');
    const { run } = recordingRunner([
      () => ({ code: -1, stdout: '', stderr: '', timedOut: true }),
    ]);

    const result = await runFetch({ url: 'https://github.com/org/repo.git', dir: target }, run);

    expect(result).toMatchObject({ ok: false, code: 'failed' });
    if (!result.ok) expect(result.detail).toContain('超时');
  });
});

describe('仓库地址归一化', () => {
  it('末尾斜杠与 .git 后缀不算差异', () => {
    expect(normalizeRepoUrl('https://GitHub.com/org/repo.git')).toBe(
      normalizeRepoUrl('https://github.com/org/repo/'),
    );
  });
});
