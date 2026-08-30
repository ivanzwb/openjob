import { describe, expect, it } from 'vitest';
import { parseLatestYml } from './latestYml';

describe('parseLatestYml', () => {
  it('解析 electron-builder 标准输出（Windows 产物）', () => {
    const yml = `version: 0.6.19
files:
  - url: OpenJob-Setup-0.6.19.exe
    sha512: abc123
    size: 12345678
path: OpenJob-Setup-0.6.19.exe
sha512: abc123
releaseDate: '2026-08-30T10:00:00.000Z'
`;
    expect(parseLatestYml(yml)).toEqual({
      version: '0.6.19',
      releaseDate: '2026-08-30T10:00:00.000Z',
    });
  });

  it('releaseDate 用双引号也能解析', () => {
    const yml = `version: 0.6.18
releaseDate: "2026-08-01T00:00:00.000Z"
`;
    expect(parseLatestYml(yml)).toEqual({
      version: '0.6.18',
      releaseDate: '2026-08-01T00:00:00.000Z',
    });
  });

  it('没有 releaseDate 时返回 null', () => {
    const yml = `version: 1.2.3
files: []
`;
    expect(parseLatestYml(yml)).toEqual({ version: '1.2.3', releaseDate: null });
  });

  it('没有 version 时返回 null', () => {
    const yml = `files: []
path: OpenJob-Setup-0.6.19.exe
`;
    expect(parseLatestYml(yml)).toEqual({ version: null, releaseDate: null });
  });

  it('files 里的 url 即使带 version 字样也不会被当成顶层键', () => {
    const yml = `version: 0.6.19
files:
  - url: OpenJob-Setup-version-check-1.0.0.exe
    size: 1
`;
    expect(parseLatestYml(yml).version).toBe('0.6.19');
  });

  it('带 v 前缀原样返回，由调用方统一归一化', () => {
    const yml = `version: v0.6.19
`;
    expect(parseLatestYml(yml).version).toBe('v0.6.19');
  });

  it('容忍 CRLF 行尾', () => {
    const yml = 'version: 0.6.19\r\nreleaseDate: \'2026-08-30T10:00:00.000Z\'\r\n';
    expect(parseLatestYml(yml)).toEqual({
      version: '0.6.19',
      releaseDate: '2026-08-30T10:00:00.000Z',
    });
  });

  it('空文本返回空结果', () => {
    expect(parseLatestYml('')).toEqual({ version: null, releaseDate: null });
    expect(parseLatestYml('   \n  ')).toEqual({ version: null, releaseDate: null });
  });
});