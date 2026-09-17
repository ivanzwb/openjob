/**
 * git 管道的加固面。
 *
 * 这一组钉的是「**不可信仓库**跑 git 时哪些入口必须关着」：不读用户配置、不弹凭据、不落地符号
 * 链接、不许 ext 传输。它们都是安全属性，将来有人顺手改掉必须红。
 */
import { describe, expect, it } from 'vitest';
import { HARDENING_ARGS, gitVersion, hardenedGitEnv, runGit } from './git';

/** 本机没有 git 时这条冒烟没有意义，直接跳过而不是假装通过 */
const hasGit = gitVersion() !== null;

describe('子进程环境：把「读用户配置」与「要凭据」堵掉', () => {
  it('禁交互与凭据助手', () => {
    const env = hardenedGitEnv({ PATH: '/usr/bin' } as NodeJS.ProcessEnv);
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
    expect(env['GIT_ASKPASS']).toBe('');
    expect(env['SSH_ASKPASS']).toBe('');
    expect(env['GIT_LFS_SKIP_SMUDGE']).toBe('1');
  });

  it('全局与系统配置指向空设备（用户 ~/.gitconfig 里的 helper / filter / insteadOf 都读不到）', () => {
    const env = hardenedGitEnv({});
    const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
    expect(env['GIT_CONFIG_GLOBAL']).toBe(nullDevice);
    expect(env['GIT_CONFIG_SYSTEM']).toBe(nullDevice);
    expect(env['GIT_CONFIG_NOSYSTEM']).toBe('1');
  });

  it('保留原有环境（否则 PATH 没了，git 自己都找不到）', () => {
    expect(hardenedGitEnv({ PATH: '/usr/bin' } as NodeJS.ProcessEnv)['PATH']).toBe('/usr/bin');
  });
});

describe('命令行加固', () => {
  it('逐项都在：禁 ext 传输、清空凭据助手、不落地符号链接', () => {
    expect(HARDENING_ARGS).toContain('protocol.ext.allow=never');
    expect(HARDENING_ARGS).toContain('credential.helper=');
    expect(HARDENING_ARGS).toContain('core.symlinks=false');
  });
});

describe('真的能跑（本机有 git 时的冒烟）', () => {
  it.runIf(hasGit)('发一条只读命令能拿到结果，且退出码可读', async () => {
    const result = await runGit(['--version'], { timeoutMs: 10_000 });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('git version');
    expect(result.timedOut).toBe(false);
  });
});
