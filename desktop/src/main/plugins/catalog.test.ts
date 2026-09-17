/**
 * 插件清单：从更新源读「能装什么」。
 *
 * 网络用假 fetch：这一层的价值是「清单怎么解析、地址怎么拼、读不到时说什么」，
 * 真的发请求只会让用例依赖网络。取回来的包体是真的签名信封，验签仍走生产代码。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as nodeCrypto from 'node:crypto';

const keys = vi.hoisted(() => {
  // vi.hoisted 在静态 import 求值之前执行，块内用不了顶层 import 绑定；
  // node:crypto 是内建模块，require 是 vitest 对这种场景的标准写法。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { generateKeyPairSync } = require('node:crypto') as typeof nodeCrypto;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publisherPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
});

const paths = { userData: '', pluginsDir: '' };

vi.mock('../paths', () => ({ getAppPaths: () => paths }));

// 信任判定直接注入公钥：本文件验的是「清单解析与包体校验」，不该去争抢
// resources/plugin-keys.json 那个真实文件——install.test 也在写它，并行跑会互相踩
vi.mock('./package/trustedKeys', () => ({
  loadTrustedPublicKeys: () => [keys.publisherPem],
}));

// 清单本身不碰库，但它经 install.ts 拉进 bootstrap，那里会重跑旧战役回填
vi.mock('../db', () => ({
  getRawDb: () => {
    throw new Error('catalog.test must not touch the real DB');
  },
}));

import { PACKAGE_MANIFEST_FILE, PACKAGE_PACK_FILE } from '@core/plugins/package/contract';
import { OFFICIAL_REPO, resolveFeedDir } from '@core/updateFeed';
import type { RolePack } from '@core/plugins/types';
import { DISTRIBUTED_ROLE_PACKS } from '@plugins';
import { signPackageFiles, encodeBundle } from './bundle';
import {
  downloadPluginBundle,
  githubApiFromFeedDir,
  listAvailablePlugins,
  parseCatalogIndex,
  parseReleaseList,
  resetPluginCatalogCache,
} from './catalog';
import { installPluginBundle, uninstallPlugin } from './install';

const publisher = { privateKey: keys.privateKey };
const PUBLISHER_PEM = keys.publisherPem;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'openjob-catalog-'));
  paths.userData = root;
  paths.pluginsDir = join(root, 'plugins');
  resetPluginCatalogCache();
});

afterEach(() => {
  rmSync(paths.userData, { recursive: true, force: true });
  resetPluginCatalogCache();
});

/** 一份签好的岗位包信封，manifest 的 id@version 就是清单里声明的那一对 */
function signedBundle(id: string, version: string): Buffer {
  const source = structuredClone(DISTRIBUTED_ROLE_PACKS[0]!) as RolePack;
  const { manifest, ...rest } = source;
  const files = signPackageFiles(
    {
      [PACKAGE_MANIFEST_FILE]: JSON.stringify({ ...manifest, id, version, dependencies: [] }),
      [PACKAGE_PACK_FILE]: JSON.stringify(rest),
    },
    publisher.privateKey,
    PUBLISHER_PEM,
  );
  return encodeBundle(files);
}

function bundleResponse(id: string, version: string): Response {
  return new Response(signedBundle(id, version), { status: 200 });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

type Routes = Record<string, () => Response | Promise<Response>>;

/** 假 fetch：按完整 URL 命中，未登记的地址一律 404 */
function fetchStub(routes: Routes): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const handler = routes[url];
    if (!handler) return new Response('not found', { status: 404 });
    return handler();
  }) as typeof fetch;
}

const OFFICIAL_API = `https://api.github.com/repos/${OFFICIAL_REPO.owner}/${OFFICIAL_REPO.repo}`;
const OFFICIAL_DIR = `https://github.com/${OFFICIAL_REPO.owner}/${OFFICIAL_REPO.repo}/releases/latest/download`;
const RELEASES_URL = `${OFFICIAL_API}/releases?per_page=100`;

function releaseAssetUrl(tag: string, file: string): string {
  return `https://github.com/${OFFICIAL_REPO.owner}/${OFFICIAL_REPO.repo}/releases/download/${tag}/${file}`;
}

describe('githubApiFromFeedDir', () => {
  it('官方仓库：留空更新源时指向官方 release 与 api.github.com', () => {
    expect(resolveFeedDir('')).toBe(OFFICIAL_DIR);
    expect(githubApiFromFeedDir(OFFICIAL_DIR)).toEqual({
      base: OFFICIAL_API,
      hostPrefix: 'https://github.com/',
      owner: OFFICIAL_REPO.owner,
      repo: OFFICIAL_REPO.repo,
    });
  });

  it('镜像前缀原样保留到 API 与附件地址上', () => {
    const mirrored = resolveFeedDir('https://gh-proxy.org/https://github.com/ivanzwb/openjob');

    const api = githubApiFromFeedDir(mirrored);

    expect(mirrored).toBe('https://gh-proxy.org/https://github.com/ivanzwb/openjob/releases/latest/download');
    expect(api?.base).toBe('https://gh-proxy.org/https://api.github.com/repos/ivanzwb/openjob');
    expect(api?.hostPrefix).toBe('https://gh-proxy.org/https://github.com/');
  });

  it('自建目录没有 release 列表可列', () => {
    expect(githubApiFromFeedDir('https://downloads.example.com/openjob')).toBeNull();
  });
});

describe('parseReleaseList', () => {
  it('形状不对的条目只丢自己，不连坐整个列表', () => {
    const parsed = parseReleaseList([
      { tag_name: 'v1', assets: [{ name: 'a@1.0.0.ojb', size: 10 }, { bad: true }] },
      { tag_name: 'v2', assets: 'nope' },
      null,
      { tag_name: 'v3', assets: [] },
    ]);

    expect(parsed).toEqual([
      { tag: 'v1', assets: [{ name: 'a@1.0.0.ojb', size: 10 }] },
      { tag: 'v3', assets: [] },
    ]);
  });

  it('不是数组就当空', () => {
    expect(parseReleaseList({ message: 'Not Found' })).toEqual([]);
  });
});

describe('parseCatalogIndex', () => {
  const valid = {
    formatVersion: 1,
    plugins: [
      {
        id: 'demo.role',
        version: '1.0.0',
        type: 'role-pack',
        displayName: '演示岗位',
        description: '说明',
        permissions: ['artifact:read'],
        file: 'demo.role@1.0.0.ojb',
        bytes: 2048,
        sha256: 'a'.repeat(64),
      },
    ],
  };

  it('读得出条目，权限与类型一并带上：装之前就要摆给用户看', () => {
    const parsed = parseCatalogIndex(valid);

    expect(parsed.ok && parsed.plugins[0]).toMatchObject({
      id: 'demo.role',
      version: '1.0.0',
      type: 'role-pack',
      displayName: '演示岗位',
      permissions: ['artifact:read'],
      file: 'demo.role@1.0.0.ojb',
      sha256: 'a'.repeat(64),
      described: true,
    });
  });

  it('格式版本不认识就整体拒绝，而不是猜着读一半', () => {
    expect(parseCatalogIndex({ ...valid, formatVersion: 2 })).toMatchObject({ ok: false });
    expect(parseCatalogIndex({ plugins: [] })).toMatchObject({ ok: false });
    expect(parseCatalogIndex('nope')).toMatchObject({ ok: false });
  });

  it('file 必须自证是包文件名：清单里的这个字段会被拼进请求地址', () => {
    for (const file of [
      '../../../etc/passwd',
      'sub/demo.role@1.0.0.ojb',
      'demo.role@1.0.0.zip',
      'https://evil.example.com/x.ojb',
    ]) {
      const parsed = parseCatalogIndex({
        ...valid,
        plugins: [{ ...valid.plugins[0], file }],
      });

      expect(parsed.ok, file).toBe(false);
    }
  });
});

describe('listAvailablePlugins', () => {
  it('GitHub：把各 release 的附件合起来，同 id 取最高版本，说明取自包自己的 manifest', async () => {
    const fetchImpl = fetchStub({
      [RELEASES_URL]: () =>
        jsonResponse([
          {
            tag_name: 'v0.6.29',
            assets: [
              { name: 'software-engineering@1.4.0.ojb', size: 111 },
              { name: 'software-engineering@1.5.0.ojb', size: 222 },
              { name: 'index.json', size: 999 },
            ],
          },
          {
            tag_name: 'plugins/product-manager@1.3.0',
            assets: [{ name: 'product-manager@1.3.0.ojb', size: 333 }],
          },
        ]),
      [releaseAssetUrl('v0.6.29', 'software-engineering@1.5.0.ojb')]: () =>
        bundleResponse('software-engineering', '1.5.0'),
      [releaseAssetUrl('plugins/product-manager@1.3.0', 'product-manager@1.3.0.ojb')]: () =>
        bundleResponse('product-manager', '1.3.0'),
    });

    const view = await listAvailablePlugins({ feedUrl: '', fetchImpl });

    expect(view.error).toBeNull();
    expect(view.source).toBe(RELEASES_URL);
    expect(view.entries.map((entry) => `${entry.id}@${entry.version}`)).toEqual([
      'product-manager@1.3.0',
      'software-engineering@1.5.0',
    ]);
    const software = view.entries.find((entry) => entry.id === 'software-engineering')!;
    expect(software.described).toBe(true);
    expect(software.type).toBe('role-pack');
    expect(software.releaseTag).toBe('v0.6.29');
    expect(software.permissions.length).toBeGreaterThan(0);
  });

  it('说明读不到时条目照样列出来，但标明没读到', async () => {
    const fetchImpl = fetchStub({
      [RELEASES_URL]: () =>
        jsonResponse([
          { tag_name: 'v1', assets: [{ name: 'demo.role@9.9.9.ojb', size: 10 }] },
        ]),
      // 附件地址不登记 → 404，读不回 manifest
    });

    const view = await listAvailablePlugins({ feedUrl: '', fetchImpl });

    expect(view.error).toBeNull();
    expect(view.entries[0]).toMatchObject({
      id: 'demo.role',
      version: '9.9.9',
      displayName: 'demo.role',
      described: false,
      type: null,
      releaseTag: 'v1',
    });
  });

  it('附件名与包内声明的 id@version 不符时不列出来：清单承诺的必须是装下去的那个', async () => {
    const fetchImpl = fetchStub({
      [RELEASES_URL]: () =>
        jsonResponse([
          { tag_name: 'v1', assets: [{ name: 'demo.role@1.0.0.ojb', size: 10 }] },
        ]),
      // 地址说 demo.role@1.0.0，包里其实自称另一个 id
      [releaseAssetUrl('v1', 'demo.role@1.0.0.ojb')]: () => bundleResponse('other.role', '2.0.0'),
    });

    const view = await listAvailablePlugins({ feedUrl: '', fetchImpl });

    expect(view.entries[0]).toMatchObject({ id: 'demo.role', version: '1.0.0', described: false });
  });

  it('GitHub 接口不通时退回读更新源目录里的 index.json', async () => {
    const fetchImpl = fetchStub({
      [RELEASES_URL]: () => jsonResponse({ message: 'rate limit' }, 403),
      [`${OFFICIAL_DIR}/index.json`]: () =>
        jsonResponse({
          formatVersion: 1,
          plugins: [
            {
              id: 'demo.role',
              version: '1.0.0',
              type: 'role-pack',
              displayName: '演示岗位',
              description: '',
              permissions: [],
              file: 'demo.role@1.0.0.ojb',
              bytes: 10,
              sha256: 'b'.repeat(64),
            },
          ],
        }),
    });

    const view = await listAvailablePlugins({ feedUrl: '', fetchImpl });

    expect(view.error).toBeNull();
    expect(view.source).toBe(`${OFFICIAL_DIR}/index.json`);
    expect(view.entries[0]).toMatchObject({ id: 'demo.role', described: true });
  });

  it('自建更新源只读目录里的 index.json', async () => {
    const dir = 'https://downloads.example.com/openjob';
    const fetchImpl = fetchStub({
      [`${dir}/index.json`]: () =>
        jsonResponse({
          formatVersion: 1,
          plugins: [
            {
              id: 'demo.role',
              version: '1.0.0',
              type: 'role-pack',
              displayName: '演示岗位',
              description: '',
              permissions: [],
              file: 'demo.role@1.0.0.ojb',
              bytes: 10,
              sha256: null,
            },
          ],
        }),
    });

    const view = await listAvailablePlugins({ feedUrl: dir, fetchImpl });

    expect(view.entries).toHaveLength(1);
    expect(view.source).toBe(`${dir}/index.json`);
  });

  it('两条路都不通时把两句原因都说出来，而不是给一片空白', async () => {
    const fetchImpl = fetchStub({
      [RELEASES_URL]: () => jsonResponse({ message: 'rate limit' }, 403),
    });

    const view = await listAvailablePlugins({ feedUrl: '', fetchImpl });

    expect(view.entries).toEqual([]);
    // index.json 404 是主因：清单还没发过，这条用户改不了，得跟「网络不通」分开说
    expect(view.error?.kind).toBe('not-published');
    expect(view.error?.message).toContain('403');
    expect(view.error?.message).toContain('index.json');
    expect(view.source).toBe(OFFICIAL_DIR);
  });

  it('网络不通时说「拉不到」，不是「没有清单」', async () => {
    const offline = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    const view = await listAvailablePlugins({ feedUrl: '', fetchImpl: offline });

    expect(view.error?.kind).toBe('unreachable');
    expect(view.error?.message).toContain('offline');
  });
});

describe('downloadPluginBundle', () => {
  const dir = 'https://downloads.example.com/openjob';
  const file = 'demo.role@1.0.0.ojb';

  function indexRoutes(sha256: string | null, body: Buffer): Routes {
    return {
      [`${dir}/index.json`]: () =>
        jsonResponse({
          formatVersion: 1,
          plugins: [
            {
              id: 'demo.role',
              version: '1.0.0',
              type: 'role-pack',
              displayName: '演示岗位',
              description: '',
              permissions: [],
              file,
              bytes: body.byteLength,
              sha256,
            },
          ],
        }),
      [`${dir}/${file}`]: () => new Response(body, { status: 200 }),
    };
  }

  it('按清单登记的摘要校验后交回包体，装得上', async () => {
    const raw = signedBundle('demo.role', '1.0.0');
    const { createHash } = await import('node:crypto');
    const fetchImpl = fetchStub(
      indexRoutes(createHash('sha256').update(raw).digest('hex'), raw),
    );

    const listed = await listAvailablePlugins({ feedUrl: dir, fetchImpl });
    expect(listed.error).toBeNull();

    const downloaded = await downloadPluginBundle({
      id: 'demo.role',
      version: '1.0.0',
      feedUrl: dir,
      fetchImpl,
    });

    expect(downloaded.ok).toBe(true);
    if (!downloaded.ok) return;
    expect(installPluginBundle(downloaded.raw)).toMatchObject({ ok: true, id: 'demo.role' });
  });

  it('内容与清单登记的摘要不符就拒装', async () => {
    const raw = signedBundle('demo.role', '1.0.0');
    const fetchImpl = fetchStub(indexRoutes('c'.repeat(64), raw));

    const downloaded = await downloadPluginBundle({
      id: 'demo.role',
      version: '1.0.0',
      feedUrl: dir,
      fetchImpl,
    });

    expect(downloaded).toMatchObject({ ok: false, code: 'checksum-mismatch' });
  });

  it('清单说 A、包里自称 B：签名证明不了「它就是你要的那个包」', async () => {
    const raw = signedBundle('other.role', '2.0.0');
    const { createHash } = await import('node:crypto');
    const fetchImpl = fetchStub(
      indexRoutes(createHash('sha256').update(raw).digest('hex'), raw),
    );

    const downloaded = await downloadPluginBundle({
      id: 'demo.role',
      version: '1.0.0',
      feedUrl: dir,
      fetchImpl,
    });

    expect(downloaded).toMatchObject({ ok: false, code: 'bundle-mismatch' });
  });

  it('清单里没有这个包就说没有，且不改动已装的插件', async () => {
    const fetchImpl = fetchStub({
      [`${dir}/index.json`]: () => jsonResponse({ formatVersion: 1, plugins: [] }),
    });

    const downloaded = await downloadPluginBundle({
      id: 'demo.role',
      version: '1.0.0',
      feedUrl: dir,
      fetchImpl,
    });

    expect(downloaded).toMatchObject({ ok: false, code: 'bundle-not-in-catalog' });
    expect(uninstallPlugin('demo.role', '1.0.0')).toEqual({ removed: false });
  });
});
