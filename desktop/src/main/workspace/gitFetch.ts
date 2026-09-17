/**
 * 「从远端拉取到本包工作区」的实现（分发计划 §11.2 工作区原语的最后一行）。
 *
 * 这一层是宿主对**不可信仓库**的唯一入口，所以策略全在这里且都可以单测：只放行公开的
 * https 地址、固定 argv、目标目录受工作区约束、体积与文件数有上限、失败/超限不留残骸。
 *
 * 刻意不做的事：
 * - 不跑任意 git 子命令（只有 clone / fetch / reset / rev-parse 四种，参数全部由这里拼）；
 * - 不传凭据、不读用户 git 配置（见 `git.ts` 的 HARDENING_ARGS 与 hardenedGitEnv）；
 * - 不做 submodule（默认不开）与 LFS（`GIT_LFS_SKIP_SMUDGE=1`）。
 */
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MISSING_GIT, assertGitAvailable, type GitRunResult } from './git';

export const FETCH_LIMITS = {
  /** URL 长度上限 */
  urlLength: 2048,
  /** 一次 clone / 更新的墙钟上限 */
  timeoutMs: 120_000,
  /** rev-parse 这类小命令的上限 */
  probeTimeoutMs: 10_000,
  /** 拉下来的目录体积上限 */
  maxBytes: 512 * 1024 * 1024,
  /** 拉下来的文件数上限（挡住扁平化的超大仓库 / 打包炸弹） */
  maxFiles: 50_000,
} as const;

export type FetchErrorCode =
  | 'invalid-url'
  | 'dir-occupied'
  | 'origin-mismatch'
  | 'git-unavailable'
  | 'limit-exceeded'
  | 'failed';

export interface FetchOutcome {
  mode: 'clone' | 'update';
  commit: string;
  /** detached HEAD 时为 null */
  branch: string | null;
  bytes: number;
  fileCount: number;
}

export type FetchResult =
  | { ok: true; outcome: FetchOutcome }
  | { ok: false; code: FetchErrorCode; detail: string };

/** 可注入的命令执行器：测试用它断言 argv、不需要真的跑 git */
export type GitRunner = (args: readonly string[]) => Promise<GitRunResult>;

export interface FetchRequest {
  url: string;
  /** 目标目录（调用方已解析成绝对路径并做过工作区约束） */
  dir: string;
}

/** 空设备之外的控制字符、空白、以及超过上限的地址一律不要 */
function hasControlOrSpace(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * 回环 / 内网 / 特殊用途主机名。
 *
 * 这一条防的是 SSRF：拉取的目标由**包**决定，不拦的话包就能拿用户这台机器当跳板去探内网
 * （`https://192.168.1.1/`、`http://router.local/`），而用户看到的只是「插件在拉代码」。
 * 域名解析到内网地址这种情况这里查不到（要真做就得上 DNS 解析后校验），属于残余风险。
 */
function isPrivateHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal')
  ) {
    return true;
  }

  const bare = lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
  if (bare.includes(':')) {
    // IPv6：回环、链路本地、唯一本地地址
    return bare === '::1' || bare.startsWith('fe80:') || /^f[cd][0-9a-f]{2}:/.test(bare);
  }

  const parts = bare.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * 只放行公开的 https 仓库地址。
 *
 * 其它传输方式都不是「下载一段代码」这么简单：`ext::` 直接执行命令；`file://` 与本地路径能读
 * 本机任意目录；`ssh://` / `git://` 会用到用户的密钥或落在明文协议上。URL 里带用户名密码也拒
 * ——包没有理由知道用户的凭据，带上去只会被写进日志或错误信息。
 */
export function validateFetchUrl(raw: unknown): { ok: true; url: string } | { ok: false; reason: string } {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: '地址不能为空' };
  if (raw.length > FETCH_LIMITS.urlLength) {
    return { ok: false, reason: `地址超过 ${FETCH_LIMITS.urlLength} 字符` };
  }
  if (hasControlOrSpace(raw)) return { ok: false, reason: '地址里有空白或控制字符' };

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: '地址不是合法 URL' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: `只支持 https 地址，不支持 ${parsed.protocol.replace(':', '')}` };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: '地址里不能带用户名或密码' };
  }
  if (parsed.hostname === '') return { ok: false, reason: '地址缺少主机名' };
  if (isPrivateHost(parsed.hostname)) {
    return { ok: false, reason: '不能指向本机或内网地址' };
  }
  if (parsed.pathname.replace(/\/+$/, '').length <= 1) {
    return { ok: false, reason: '地址缺少仓库路径' };
  }
  return { ok: true, url: parsed.toString() };
}

/** 比较「是不是同一个仓库」时去掉末尾斜杠与 `.git` 后缀的差异 */
export function normalizeRepoUrl(url: string): string {
  return url
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * 由地址推导一个目录名（包没指定 dir 时用）。
 *
 * 取路径最后两段做 slug：`..`、绝对路径、控制字符都在这道 slug 化里被抹掉，产物只可能是
 * `[a-z0-9._-]`；再没有可用字符就退成 `checkout`。真正的边界仍由调用方的 `confine` 把关。
 */
export function deriveDirName(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return 'checkout';
  }
  const segments = path
    .split('/')
    .filter(Boolean)
    .slice(-2)
    .map((segment) =>
      segment
        .replace(/\.git$/i, '')
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^[-.]+|[-.]+$/g, ''),
    )
    .filter(Boolean);
  const slug = segments.join('-').slice(0, 64).replace(/[-.]+$/, '');
  return slug || 'checkout';
}

/** clone 的 argv：深度 1、单分支、不要 tags；`--` 终止选项解析，URL 不可能被当成选项 */
export function buildCloneArgv(url: string, dir: string): string[] {
  return ['clone', '--depth', '1', '--single-branch', '--no-tags', '--quiet', '--', url, dir];
}

/**
 * 更新的 argv：fetch 深度 1 的 origin HEAD，再硬重置到它。
 *
 * 不用 `pull`：这里是包的临时检出，本地改动没有保留价值，而 `pull` 会在分叉时留下合并冲突，
 * 让「拉到最新」变成要包自己解决的合并问题。**这个语义要写在原语文档里**。
 */
export function buildUpdateArgvs(dir: string): string[][] {
  return [
    ['-C', dir, 'fetch', '--depth', '1', '--no-tags', 'origin', 'HEAD'],
    ['-C', dir, 'reset', '--hard', 'FETCH_HEAD'],
  ];
}

function isEmptyDir(path: string): boolean {
  try {
    return readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

function isGitCheckout(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

export interface DirMeasure {
  bytes: number;
  fileCount: number;
  exceeded: 'bytes' | 'files' | null;
}

/**
 * 统计目录体积与文件数，超上限就提前收工。
 *
 * 用 `lstatSync` 且**不跟随符号链接**：拉取时已经禁了链接（`core.symlinks=false`），但包自己
 * 也可能在工作区里建链接，遍历时不能顺着它跑出工作区。
 */
export function measureDir(
  dir: string,
  limits: { maxBytes: number; maxFiles: number } = FETCH_LIMITS,
): DirMeasure {
  let bytes = 0;
  let fileCount = 0;
  const stack = [dir];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      fileCount += 1;
      try {
        bytes += lstatSync(path).size;
      } catch {
        // 读不到大小就按 0 计，不该因为一个文件失败而整批作废
      }
      if (fileCount > limits.maxFiles) return { bytes, fileCount, exceeded: 'files' };
      if (bytes > limits.maxBytes) return { bytes, fileCount, exceeded: 'bytes' };
    }
  }

  return { bytes, fileCount, exceeded: null };
}

/** 把错误文本里的本机路径抹掉：包只该知道「工作区里的相对位置」，不该知道用户的家目录 */
function redact(text: string, dir: string): string {
  return text.split(dir).join('(workspace)').split(dirname(dir)).join('(workspace)');
}

function short(text: string, limit = 400): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * 拉取到 `req.dir`。
 *
 * 目标目录已存在时：是 git 检出就**更新**（fetch + 硬重置），非空又不是检出就拒（那是包自己的
 * 数据，不能被拉取覆盖），空目录当 clone。更新前还会核对 origin，避免两个不同的仓库被包指到
 * 同一个目录上而互相覆盖——那种情况下包只会看到「仓库内容莫名其妙变了」。
 */
export async function runFetch(
  req: FetchRequest,
  run: GitRunner,
  measureLimits: { maxBytes: number; maxFiles: number } = FETCH_LIMITS,
): Promise<FetchResult> {
  try {
    assertGitAvailable();
  } catch {
    return { ok: false, code: 'git-unavailable', detail: MISSING_GIT };
  }

  const exists = existsSync(req.dir);
  let mode: 'clone' | 'update';

  if (exists && isGitCheckout(req.dir)) {
    const origin = await run(['-C', req.dir, 'remote', 'get-url', 'origin']);
    const current = origin.stdout.trim();
    if (origin.code !== 0 || current === '') {
      return { ok: false, code: 'failed', detail: redact(origin.stderr, req.dir) || '读不到 origin' };
    }
    if (normalizeRepoUrl(current) !== normalizeRepoUrl(req.url)) {
      return {
        ok: false,
        code: 'origin-mismatch',
        detail: `该目录已经是另一个仓库的检出（${short(normalizeRepoUrl(current), 120)}）`,
      };
    }

    for (const argv of buildUpdateArgvs(req.dir)) {
      const step = await run(argv);
      if (step.code !== 0) {
        return {
          ok: false,
          code: 'failed',
          detail: step.timedOut ? '拉取超时' : redact(step.stderr, req.dir),
        };
      }
    }
    mode = 'update';
  } else {
    if (exists && !isEmptyDir(req.dir)) {
      return { ok: false, code: 'dir-occupied', detail: '目标目录非空，且不是本原语拉下来的检出' };
    }

    const clone = await run(buildCloneArgv(req.url, req.dir));
    if (clone.code !== 0) {
      // 失败不留残骸：半个检出会让下一次重试撞上「目录非空」
      rmSync(req.dir, { recursive: true, force: true });
      return {
        ok: false,
        code: 'failed',
        detail: clone.timedOut ? '拉取超时' : redact(clone.stderr, req.dir) || 'git clone 失败',
      };
    }
    mode = 'clone';
  }

  const measure = measureDir(req.dir, measureLimits);
  if (measure.exceeded !== null) {
    rmSync(req.dir, { recursive: true, force: true });
    const limit =
      measure.exceeded === 'bytes'
        ? `${Math.round(measureLimits.maxBytes / 1024 / 1024)} MB`
        : `${measureLimits.maxFiles} 个文件`;
    return { ok: false, code: 'limit-exceeded', detail: `拉下来的内容超过上限（${limit}），已清理` };
  }

  const head = await run(['-C', req.dir, 'rev-parse', 'HEAD']);
  if (head.code !== 0 || head.stdout === '') {
    return { ok: false, code: 'failed', detail: redact(head.stderr, req.dir) || '读不到提交' };
  }
  const branchRef = await run(['-C', req.dir, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const branchName = branchRef.code === 0 ? branchRef.stdout.trim() : '';

  return {
    ok: true,
    outcome: {
      mode,
      commit: head.stdout.trim(),
      branch: branchName === '' || branchName === 'HEAD' ? null : branchName,
      bytes: measure.bytes,
      fileCount: measure.fileCount,
    },
  };
}
