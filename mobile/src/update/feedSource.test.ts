import { describe, expect, it } from 'vitest';
import { genericPageUrl, resolveFeedBase } from './feedSource';

describe('resolveFeedBase', () => {
  it('空串 / 纯空白视为未配置，返回 null', () => {
    expect(resolveFeedBase('')).toBeNull();
    expect(resolveFeedBase('   ')).toBeNull();
  });

  it('GitHub 仓库地址（完整 URL）规整成 releases/latest/download', () => {
    expect(resolveFeedBase('https://github.com/ivanzwb/openjob')).toBe(
      'https://github.com/ivanzwb/openjob/releases/latest/download',
    );
  });

  it('带末尾斜杠 / .git 后缀的 GitHub 地址同样规整', () => {
    expect(resolveFeedBase('https://github.com/ivanzwb/openjob/')).toBe(
      'https://github.com/ivanzwb/openjob/releases/latest/download',
    );
    expect(resolveFeedBase('https://github.com/ivanzwb/openjob.git')).toBe(
      'https://github.com/ivanzwb/openjob/releases/latest/download',
    );
  });

  it('裸 owner/repo 不带协议头，按桌面端契约原样透传', () => {
    // 与 src/main/updater.test.ts 的 normalizeFeedUrl 行为一致：
    // 只有显式出现 github.com/ 才会补资产路径，裸写不猜
    expect(resolveFeedBase('ivanzwb/openjob')).toBe('ivanzwb/openjob');
  });

  it('完整的 GitHub 下载目录地址原样保留', () => {
    const url = 'https://github.com/ivanzwb/openjob/releases/latest/download';
    expect(resolveFeedBase(url)).toBe(url);
  });

  it('gh-proxy 镜像前缀保留，且规则作用在镜像内的 GitHub 地址上', () => {
    expect(resolveFeedBase('https://gh-proxy.com/https://github.com/ivanzwb/openjob')).toBe(
      'https://gh-proxy.com/https://github.com/ivanzwb/openjob/releases/latest/download',
    );
  });

  it('自建目录原样保留', () => {
    const url = 'https://example.com/openjob-updates';
    expect(resolveFeedBase(url)).toBe(url);
  });
});

describe('genericPageUrl', () => {
  it('GitHub 下载目录指回发布页', () => {
    expect(genericPageUrl('https://github.com/ivanzwb/openjob/releases/latest/download')).toBe(
      'https://github.com/ivanzwb/openjob/releases/latest',
    );
  });

  it('gh-proxy 镜像的下载目录指回镜像内的发布页', () => {
    expect(
      genericPageUrl(
        'https://gh-proxy.com/https://github.com/ivanzwb/openjob/releases/latest/download',
      ),
    ).toBe('https://gh-proxy.com/https://github.com/ivanzwb/openjob/releases/latest');
  });

  it('自建目录没有发布页，返回目录本身', () => {
    const url = 'https://example.com/openjob-updates';
    expect(genericPageUrl(url)).toBe(url);
  });
});