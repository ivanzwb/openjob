/**
 * 插件清单：从更新源读「现在能装哪些包」。
 *
 * 来源与自动更新同一处（`core/src/updateFeed.ts` 的 resolveFeedDir）：更新源填了就用它，
 * 留空走官方 GitHub Release。这样用户把更新源指到镜像时插件包也跟着走镜像，不会出现
 * 「应用能更新、插件却连不上 GitHub」这种两头堵的组合。
 *
 * 读取分两条路，因为发布本来就有两条：
 * - **GitHub**：列 release（含 prerelease），把各 release 附件里的 `<id>@<version>.ojb`
 *   合起来，同 id 取最高版本。插件可以单独发一版（tag `plugins/<id>@<version>`），
 *   只读「最新一版应用挂在 releases/latest 下的附件」就会漏掉那些包。
 * - **自建/通用目录**：读目录里的 `index.json`（`pack-plugins.mjs` 产出，随 release 一起传）。
 *
 * 附件名只能给出 id@version。清单里带说明，靠的是把包取回来读它自己的 manifest——包只有
 * 几 KB，读不到时条目仍然列出来（described=false，界面少说两句），而不是替它编一段说明。
 */
import { createHash } from 'node:crypto';
import { PLUGIN_TYPES, type PluginType } from '@core/enums';
import type { PluginCatalogEntry, PluginCatalogView } from '@core/ipc';
import { compareExactSemVer } from '@core/plugins/registry';
import { resolveFeedDir } from '@core/updateFeed';
import { MAX_BUNDLE_BYTES, parseBundle } from './install';

/**
 * 清单最多列这么多条。
 *
 * 附件数量由发布方决定，而这里每一条都要取回包体读 manifest；上限让一个失控的发布页
 * 不至于把界面和网络一起拖住（20 个包，正常发布远到不了）。
 */
const MAX_ENTRIES = 20;

/** 清单本身（一次 HTTP 往返）的超时 */
const LIST_TIMEOUT_MS = 15_000;

/**
 * 包体下载的超时：包体随包内资产增长（当前最大的是几百 KB 的压缩文本），
 * 慢到这个程度已经不是「稍慢」，而是连接卡死了
 */
const BUNDLE_TIMEOUT_MS = 30_000;

/** 包体下载的尝试次数：CDN 上偶发的重置/握手失败重试一次就过去了 */
const BUNDLE_DOWNLOAD_ATTEMPTS = 2;

/** 清单缓存有效期：装的时候复用刚拉到的地址，不再重列一遍 release */
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * 附件名 / 清单里的文件名：`<id>@<version>.ojb`（gzip 压缩的分发容器，见 install.ts）。
 *
 * 字符集收在 URL 路径安全范围内（含 `@` 与 `+`）：这两个名字都会被直接拼进请求地址，
 * 允许空格、斜杠、`..` 就等于允许它跳到别的路径上去。
 */
const BUNDLE_NAME = /^([A-Za-z0-9._-]+)@([A-Za-z0-9._+-]+)\.ojb$/;

/** GitHub 的仓库坐标与 API 前缀（镜像场景下前缀不是 github.com） */
interface GithubApi {
  /** 例：https://api.github.com/repos/ivanzwb/openjob 或 https://gh-proxy.org/https://api.github.com/repos/ivanzwb/openjob */
  base: string;
  /** 例：https://github.com/ 或 https://gh-proxy.org/https://github.com/ */
  hostPrefix: string;
  owner: string;
  repo: string;
}

/** 一条可下载记录的定位信息。渲染层拿不到它——地址只在主进程里流转。 */
interface DownloadRef {
  url: string;
  /** index.json 登记过摘要时校验用；release 附件这条路没有摘要，验签才是权威 */
  sha256: string | null;
  releaseTag: string | null;
  bytes: number | null;
}

interface CatalogCache {
  feedUrl: string;
  at: number;
  refs: Map<string, DownloadRef>;
}

let cache: CatalogCache | null = null;

/** 测试用：清掉缓存，让下一次安装重新拉清单 */
export function resetPluginCatalogCache(): void {
  cache = null;
}

type FetchLike = typeof fetch;

/**
 * 把连接层失败的原因摊开。
 *
 * undici 在连不上时只给一句 “fetch failed”，真正的原因（DNS 解析不到、TLS 握手超时、
 * 连接被重置、整体超时中止）挂在 `cause` 链上。用户要判断这是自己的网络、镜像还是发布方
 * 的问题，就得看到它，而不是一句无从下手的 fetch failed。
 */
function messageOf(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error && parts.length < 4) {
    const text = current.message || current.name;
    if (text) parts.push(text);
    current = current.cause;
  }
  if (parts.length === 0) return String(error);
  return parts.length === 1 ? parts[0]! : `${parts[0]}（底层原因：${parts.slice(1).join('、')}）`;
}

function entryKey(id: string, version: string): string {
  return `${id}@${version}`;
}

/**
 * 从产物目录反推 GitHub 仓库坐标与 API 前缀。
 *
 * 镜像前缀原样保留（`gh-proxy.org/https://github.com/...` → `gh-proxy.org/https://api.github.com/...`）：
 * 只改后半段的话，镜像用户会被指回墙外的 api.github.com，等于把清单这条路封死。
 * 不是 GitHub 地址就返回 null——自建目录没有 release 列表可列。
 */
export function githubApiFromFeedDir(feedDir: string): GithubApi | null {
  const marker = feedDir.toLowerCase().lastIndexOf('github.com/');
  if (marker < 0) return null;

  const rest = feedDir.slice(marker + 'github.com/'.length).split('/');
  const owner = rest[0];
  const repo = rest[1];
  if (!owner || !repo) return null;

  const prefix = feedDir.slice(0, marker);
  return {
    base: `${prefix}api.github.com/repos/${owner}/${repo}`,
    hostPrefix: `${prefix}github.com/`,
    owner,
    repo,
  };
}

/** release 列表里我们认得出的一条。形状宽松解析：接口给的字段比这里多得多。 */
interface ReleaseAssets {
  tag: string;
  assets: Array<{ name: string; size: number | null }>;
}

/**
 * 解析 releases 接口的响应，挑出插件包附件。
 *
 * 逐条宽松校验：一条形状不对只丢它自己，不连坐整个列表——发布页里混进一个怪 release
 * 不该让「能装什么」整个看不见。
 */
export function parseReleaseList(json: unknown): ReleaseAssets[] {
  if (!Array.isArray(json)) return [];
  const out: ReleaseAssets[] = [];
  for (const item of json) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as { tag_name?: unknown; assets?: unknown };
    if (typeof record.tag_name !== 'string' || !Array.isArray(record.assets)) continue;
    const assets: ReleaseAssets['assets'] = [];
    for (const asset of record.assets) {
      if (typeof asset !== 'object' || asset === null) continue;
      const fields = asset as { name?: unknown; size?: unknown };
      if (typeof fields.name !== 'string') continue;
      assets.push({ name: fields.name, size: typeof fields.size === 'number' ? fields.size : null });
    }
    out.push({ tag: record.tag_name, assets });
  }
  return out;
}

/** 清单里的一条，形状校验后归一化 */
interface IndexedPlugin extends PluginCatalogEntry {
  file: string;
  sha256: string | null;
}

/**
 * 解析自建目录里的 index.json。
 *
 * 格式对不上就整体拒绝：这份文件是「能装什么」的唯一依据，读一半猜一半会让界面显示一些
 * 装不上的东西。`file` 字段会被拼进请求地址，所以必须自证是一个文件名。
 */
export function parseCatalogIndex(
  json: unknown,
): { ok: true; plugins: IndexedPlugin[] } | { ok: false; detail: string } {
  if (typeof json !== 'object' || json === null) return { ok: false, detail: '不是 JSON 对象' };
  const record = json as { formatVersion?: unknown; plugins?: unknown };
  if (record.formatVersion !== 1) {
    return { ok: false, detail: `清单格式版本不认识：${String(record.formatVersion)}` };
  }
  if (!Array.isArray(record.plugins)) return { ok: false, detail: '缺少 plugins 数组' };

  const plugins: IndexedPlugin[] = [];
  for (const item of record.plugins) {
    if (typeof item !== 'object' || item === null) {
      return { ok: false, detail: 'plugins 里出现了非对象条目' };
    }
    const entry = item as Record<string, unknown>;
    const { id, version, file } = entry;
    if (typeof id !== 'string' || typeof version !== 'string') {
      return { ok: false, detail: '插件条目缺少 id 或 version' };
    }
    if (typeof file !== 'string' || !BUNDLE_NAME.test(file)) {
      return { ok: false, detail: `${id}@${version} 的 file 不是合法的包文件名：${String(file)}` };
    }
    plugins.push({
      id,
      version,
      type: pluginTypeOf(entry.type),
      displayName: typeof entry.displayName === 'string' ? entry.displayName : id,
      description: typeof entry.description === 'string' ? entry.description : '',
      permissions: stringListOf(entry.permissions),
      bytes: typeof entry.bytes === 'number' ? entry.bytes : null,
      releaseTag: null,
      described: true,
      file,
      sha256: typeof entry.sha256 === 'string' ? entry.sha256 : null,
    });
  }
  return { ok: true, plugins };
}

function pluginTypeOf(value: unknown): PluginType | null {
  return PLUGIN_TYPES.includes(value as PluginType) ? (value as PluginType) : null;
}

function stringListOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * 按上限读取响应体。
 *
 * 更新源是用户自己填的地址，不能假设它给的数据有多小：先看 content-length，没有就边读边数，
 * 超限立刻断开，而不是先把几百 MB 收进内存再判断。
 */
async function readCapped(res: Response, cap: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > cap) return null;

  const body = res.body;
  if (body === null) {
    const buffer = Buffer.from(await res.arrayBuffer());
    return buffer.length > cap ? null : buffer;
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function getJson(url: string, doFetch: FetchLike): Promise<
  { ok: true; json: unknown } | { ok: false; status: number | null; detail: string }
> {
  let res: Response;
  try {
    res = await doFetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'openjob' },
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, status: null, detail: messageOf(error) };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, detail: `HTTP ${res.status}` };
  }
  try {
    return { ok: true, json: (await res.json()) as unknown };
  } catch (error) {
    return { ok: false, status: res.status, detail: `响应不是 JSON：${messageOf(error)}` };
  }
}

/** 包体：下载 → 读 manifest → 组装成界面要的条目 */
async function describeBundle(
  url: string,
  expected: { id: string; version: string },
  releaseTag: string | null,
  bytes: number | null,
  doFetch: FetchLike,
): Promise<PluginCatalogEntry | null> {
  let raw: Buffer | null;
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(BUNDLE_TIMEOUT_MS) });
    if (!res.ok) return null;
    raw = await readCapped(res, MAX_BUNDLE_BYTES);
  } catch {
    return null;
  }
  if (raw === null) return null;

  const bundle = parseBundle(raw);
  if (!bundle.ok) return null;

  const manifestText = bundle.files['manifest.json'];
  if (typeof manifestText !== 'string') return null;
  let manifest: { id?: unknown; version?: unknown; type?: unknown; displayName?: unknown; description?: unknown; permissions?: unknown };
  try {
    manifest = JSON.parse(manifestText) as typeof manifest;
  } catch {
    return null;
  }
  // 附件名说 A@1 而包里自称 B@2 时不能列出来：清单承诺的和装下去的必须是同一个东西
  if (manifest.id !== expected.id || manifest.version !== expected.version) return null;

  return {
    id: expected.id,
    version: expected.version,
    type: pluginTypeOf(manifest.type),
    displayName: typeof manifest.displayName === 'string' ? manifest.displayName : expected.id,
    description: typeof manifest.description === 'string' ? manifest.description : '',
    permissions: stringListOf(manifest.permissions),
    bytes,
    releaseTag,
    described: true,
  };
}

/** 只认得出文件名时的条目：界面据此显示 id，而不是假装知道它是什么 */
function bareEntry(id: string, version: string, bytes: number | null, releaseTag: string | null): PluginCatalogEntry {
  return {
    id,
    version,
    type: null,
    displayName: id,
    description: '',
    permissions: [],
    bytes,
    releaseTag,
    described: false,
  };
}

interface Listed {
  source: string;
  entries: PluginCatalogEntry[];
  refs: Map<string, DownloadRef>;
}

/**
 * 读不到清单的原因分类。
 *
 * 「还没发过清单」和「网络不通」要分开：前者用户改不了（等发布方），后者能自己动手
 * （换镜像、检查网络）——归成一类的话，界面只能说一句含糊的「失败了」。
 */
interface ListFailure {
  ok: false;
  kind: 'unreachable' | 'not-published' | 'malformed';
  message: string;
}

function listFailure(kind: ListFailure['kind'], message: string): ListFailure {
  return { ok: false, kind, message };
}

/** GitHub：列 release，把各版本附件合并成一份清单 */
async function listFromReleases(
  api: GithubApi,
  doFetch: FetchLike,
): Promise<{ ok: true; listed: Listed } | ListFailure> {
  const url = `${api.base}/releases?per_page=100`;
  const res = await getJson(url, doFetch);
  if (!res.ok) {
    const hint =
      res.status === 403
        ? '（GitHub 对未登录的接口调用限额每小时 60 次，稍后再试）'
        : res.status === 404
          ? '（仓库不存在或未公开）'
          : '';
    return listFailure('unreachable', `发布列表读不到 ${url}：${res.detail}${hint}`);
  }

  // 同 id 取最高版本：插件可以单独发版，同一个 id 会在多个 release 里各出现一次
  const best = new Map<string, { id: string; version: string; tag: string; bytes: number | null }>();
  for (const release of parseReleaseList(res.json)) {
    for (const asset of release.assets) {
      const matched = BUNDLE_NAME.exec(asset.name);
      const id = matched?.[1];
      const version = matched?.[2];
      if (id === undefined || version === undefined) continue;
      // tag 会被拼进下载地址。git 不允许 ref 里出现 `..`，这里再挡一道把话说死：
      // 拼出来的地址只可能落在本仓库的 release 路径下
      if (release.tag.includes('..')) continue;
      const current = best.get(id);
      if (current && compareExactSemVer(version, current.version) <= 0) continue;
      best.set(id, { id, version, tag: release.tag, bytes: asset.size });
    }
  }

  const chosen = [...best.values()]
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .slice(0, MAX_ENTRIES);

  const refs = new Map<string, DownloadRef>();
  const entries = await Promise.all(
    chosen.map(async (item) => {
      const file = `${entryKey(item.id, item.version)}.ojb`;
      // 自己拼附件地址而不是用接口给的 browser_download_url：镜像场景下那个字段指回
      // github.com 直连地址，等于让用户绕过自己配的镜像
      const downloadUrl = `${api.hostPrefix}${api.owner}/${api.repo}/releases/download/${item.tag}/${file}`;
      refs.set(entryKey(item.id, item.version), {
        url: downloadUrl,
        sha256: null,
        releaseTag: item.tag,
        bytes: item.bytes,
      });
      const described = await describeBundle(
        downloadUrl,
        { id: item.id, version: item.version },
        item.tag,
        item.bytes,
        doFetch,
      );
      return described ?? bareEntry(item.id, item.version, item.bytes, item.tag);
    }),
  );

  return { ok: true, listed: { source: url, entries, refs } };
}

/** 自建/通用目录：读 index.json */
async function listFromIndex(
  dir: string,
  doFetch: FetchLike,
): Promise<{ ok: true; listed: Listed } | ListFailure> {
  const url = `${dir}/index.json`;
  const res = await getJson(url, doFetch);
  if (!res.ok) {
    if (res.status === 404) {
      return listFailure(
        'not-published',
        `${url} 不存在：更新源目录里要有 index.json（打包脚本与 CI 会随包一起产出）`,
      );
    }
    return listFailure('unreachable', `插件清单读不到：${url} —— ${res.detail}`);
  }

  const parsed = parseCatalogIndex(res.json);
  if (!parsed.ok) return listFailure('malformed', `插件清单格式不对：${parsed.detail}`);

  const refs = new Map<string, DownloadRef>();
  const entries = parsed.plugins.slice(0, MAX_ENTRIES).map((plugin) => {
    refs.set(entryKey(plugin.id, plugin.version), {
      url: `${dir}/${plugin.file}`,
      sha256: plugin.sha256,
      releaseTag: plugin.releaseTag,
      bytes: plugin.bytes,
    });
    const { file: _file, sha256: _sha256, ...entry } = plugin;
    return entry;
  });

  return { ok: true, listed: { source: url, entries, refs } };
}

function remember(feedUrl: string, listed: Listed, at: number): void {
  cache = { feedUrl, at, refs: listed.refs };
}

/**
 * 拉取可安装清单。
 *
 * GitHub 走 release 列表，其余走目录里的 index.json；GitHub 接口不通（限额、镜像没代理
 * api.github.com）时退回读 index.json，一条路断了不至于让界面空白。
 */
export async function listAvailablePlugins(options: {
  feedUrl: string;
  fetchImpl?: FetchLike;
  now?: () => number;
}): Promise<PluginCatalogView> {
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const fetchedAt = now();
  const dir = resolveFeedDir(options.feedUrl);

  const api = githubApiFromFeedDir(dir);
  if (api) {
    const fromReleases = await listFromReleases(api, doFetch);
    if (fromReleases.ok) {
      remember(options.feedUrl, fromReleases.listed, fetchedAt);
      return {
        source: fromReleases.listed.source,
        fetchedAt,
        entries: fromReleases.listed.entries,
        error: null,
      };
    }
    const fromIndex = await listFromIndex(dir, doFetch);
    if (fromIndex.ok) {
      remember(options.feedUrl, fromIndex.listed, fetchedAt);
      return {
        source: fromIndex.listed.source,
        fetchedAt,
        entries: fromIndex.listed.entries,
        error: null,
      };
    }
    return {
      source: dir,
      fetchedAt,
      entries: [],
      // 两条都断了：原因取清单那条（它更接近「用户能做什么」），但两句都摆出来
      error: { kind: fromIndex.kind, message: `${fromReleases.message}\n${fromIndex.message}` },
    };
  }

  const fromIndex = await listFromIndex(dir, doFetch);
  if (fromIndex.ok) {
    remember(options.feedUrl, fromIndex.listed, fetchedAt);
    return { source: fromIndex.listed.source, fetchedAt, entries: fromIndex.listed.entries, error: null };
  }
  return {
    source: dir,
    fetchedAt,
    entries: [],
    error: { kind: fromIndex.kind, message: fromIndex.message },
  };
}

export type CatalogDownloadResult =
  | { ok: true; raw: Buffer }
  | { ok: false; code: 'catalog-unavailable' | 'bundle-not-in-catalog' | 'download-failed' | 'checksum-mismatch' | 'bundle-mismatch'; detail: string };

/**
 * 按 id@version 取回包体。
 *
 * 地址由主进程自己解析：渲染层只说装哪个，说不了从哪装。
 */
export async function downloadPluginBundle(options: {
  id: string;
  version: string;
  feedUrl: string;
  fetchImpl?: FetchLike;
  now?: () => number;
}): Promise<CatalogDownloadResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const now = (options.now ?? Date.now)();
  const key = entryKey(options.id, options.version);

  let ref =
    cache && cache.feedUrl === options.feedUrl && now - cache.at < CACHE_TTL_MS
      ? cache.refs.get(key)
      : undefined;

  if (!ref) {
    // 缓存过期或换了更新源：重列一次，而不是拿旧地址去撞 404
    const view = await listAvailablePlugins(options);
    if (view.error) {
      return { ok: false, code: 'catalog-unavailable', detail: view.error.message };
    }
    ref = cache?.refs.get(key);
    if (!ref) {
      return {
        ok: false,
        code: 'bundle-not-in-catalog',
        detail: `${key} 不在更新源的清单里，刷新清单看看它是不是已经下架。`,
      };
    }
  }

  let raw: Buffer | null = null;
  let lastError: unknown = null;
  // 包体走发布页的下载地址，会被重定向到 CDN；CDN 上偶发重置/握手超时，重试一次就过去了，
  // 直接把失败摊给用户等于让用户自己碰运气
  for (let attempt = 0; attempt < BUNDLE_DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const res = await doFetch(ref.url, { signal: AbortSignal.timeout(BUNDLE_TIMEOUT_MS) });
      if (!res.ok) {
        return { ok: false, code: 'download-failed', detail: `下载 ${ref.url} 返回 HTTP ${res.status}` };
      }
      raw = await readCapped(res, MAX_BUNDLE_BYTES);
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (raw === null && lastError !== null) {
    return {
      ok: false,
      code: 'download-failed',
      detail:
        `下载 ${ref.url} 失败：${messageOf(lastError)}。` +
        '包体取自更新源，连不上时可以在设置里把更新源指到镜像，或稍后重试。',
    };
  }
  if (raw === null) {
    return { ok: false, code: 'download-failed', detail: `包体超过 ${MAX_BUNDLE_BYTES} 字节上限，已中断` };
  }

  if (ref.sha256 !== null) {
    const digest = createHash('sha256').update(raw).digest('hex');
    if (digest !== ref.sha256.toLowerCase()) {
      return {
        ok: false,
        code: 'checksum-mismatch',
        detail: '下载到的内容与清单登记的摘要不符（传输被改动，或清单与包不是同一版）。',
      };
    }
  }

  // 清单说装 A，包里自称 B：签名只能证明「这个包没被改过」，证明不了「它就是你要的那个包」
  const bundle = parseBundle(raw);
  if (bundle.ok) {
    const manifestText = bundle.files['manifest.json'];
    const manifest =
      typeof manifestText === 'string'
        ? (JSON.parse(manifestText) as { id?: unknown; version?: unknown })
        : null;
    if (manifest && (manifest.id !== options.id || manifest.version !== options.version)) {
      return {
        ok: false,
        code: 'bundle-mismatch',
        detail: `清单里的 ${key} 取回来却是 ${String(manifest.id)}@${String(manifest.version)}，已拒绝安装。`,
      };
    }
  }

  return { ok: true, raw };
}
