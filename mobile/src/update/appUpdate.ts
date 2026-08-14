import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import * as Application from 'expo-application';
import * as IntentLauncher from 'expo-intent-launcher';
import { Directory, File, Paths } from 'expo-file-system';
import { compareVersions, normalizeVersion } from '../lib/semver';

/**
 * 应用内新版检测与升级。
 *
 * 发布渠道：CI 在推 `v*` tag 时构建 `OpenJob-<version>.apk` 并挂到同名 GitHub Release，
 * 所以「最新版本」直接问 Releases API 就够了，不需要另建更新服务器。匿名调用有每小时
 * 60 次的限流，因此检测只在用户点按时发起，不做轮询。
 */

const REPO = 'ivanzwb/openjob';
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
/** 拿不到 APK（iOS、或 release 里没挂资产）时给用户兜底的落地页 */
export const RELEASES_PAGE_URL = `https://github.com/${REPO}/releases/latest`;

const CHECK_TIMEOUT_MS = 15_000;

/** 系统安装器是另一个进程，不带这个 flag 它读不到我们私有目录的 content:// */
const FLAG_GRANT_READ_URI_PERMISSION = 0x00000001;
const APK_MIME_TYPE = 'application/vnd.android.package-archive';
const ACTION_VIEW = 'android.intent.action.VIEW';
const ACTION_INSTALL_PACKAGE = 'android.intent.action.INSTALL_PACKAGE';

/** 任务 key 走全局任务仓库：切页再回来仍能看到检测/下载还在跑 */
export const APP_UPDATE_CHECK_TASK = 'app-update:check';
export const APP_UPDATE_INSTALL_TASK = 'app-update:install';

export interface LatestRelease {
  /** 归一化后的版本号（无 `v` 前缀） */
  version: string;
  tagName: string;
  publishedAt: string | null;
  pageUrl: string;
  apkUrl: string | null;
  apkSize: number | null;
}

export interface UpdateCheck {
  currentVersion: string;
  latest: LatestRelease;
  hasUpdate: boolean;
}

interface ReleaseAssetPayload {
  name?: unknown;
  size?: unknown;
  browser_download_url?: unknown;
}

interface ReleasePayload {
  tag_name?: unknown;
  published_at?: unknown;
  html_url?: unknown;
  assets?: unknown;
}

interface AppUpdateState {
  /** 最近一次检测结果。卡片重新挂载后要能接着显示，所以存在 React 树外面 */
  check: UpdateCheck | null;
  /** 下载百分比；null 表示没在下载，或服务端没给 Content-Length 无法计算 */
  percent: number | null;
}

let state: AppUpdateState = { check: null, percent: null };
const listeners = new Set<() => void>();

function setState(patch: Partial<AppUpdateState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): AppUpdateState {
  return state;
}

export function useAppUpdateState(): AppUpdateState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 当前安装版本。用 expo-application 而不是 expo-constants：
 * nativeApplicationVersion 读的是已安装 APK 的 versionName，跟用户手里跑的那个包一致。
 */
export function getCurrentVersion(): string {
  return normalizeVersion(Application.nativeApplicationVersion ?? '0.0.0');
}

async function fetchLatestRelease(): Promise<ReleasePayload> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(LATEST_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('连接 GitHub 超时，请检查网络后重试');
    }
    throw new Error('无法连接 GitHub，请检查网络后重试');
  } finally {
    clearTimeout(timer);
  }

  // 匿名调用被限流时 GitHub 返回 403（偶尔 429），文案要说清是限流而不是网络问题
  if (response.status === 403 || response.status === 429) {
    throw new Error('GitHub 接口限流（匿名调用每小时 60 次），请稍后再试');
  }
  if (response.status === 404) {
    throw new Error('GitHub 上还没有发布任何版本');
  }
  if (!response.ok) {
    throw new Error(`GitHub 接口返回 ${response.status}，请稍后再试`);
  }

  try {
    return (await response.json()) as ReleasePayload;
  } catch {
    throw new Error('GitHub 返回的内容无法解析，请稍后再试');
  }
}

function pickApkAsset(assets: unknown): ReleaseAssetPayload | null {
  if (!Array.isArray(assets)) return null;
  for (const asset of assets as ReleaseAssetPayload[]) {
    const name = typeof asset?.name === 'string' ? asset.name : '';
    if (name.toLowerCase().endsWith('.apk')) return asset;
  }
  return null;
}

/** 检测最新版本，结果写进模块仓库供界面复用 */
export async function checkForUpdate(): Promise<UpdateCheck> {
  const payload = await fetchLatestRelease();
  const tagName = typeof payload.tag_name === 'string' ? payload.tag_name.trim() : '';
  if (!tagName) throw new Error('GitHub 最新发布里没有版本号，请稍后再试');

  const apk = pickApkAsset(payload.assets);
  const apkUrl = typeof apk?.browser_download_url === 'string' ? apk.browser_download_url : null;
  const version = normalizeVersion(tagName);
  const currentVersion = getCurrentVersion();
  const result: UpdateCheck = {
    currentVersion,
    hasUpdate: compareVersions(version, currentVersion) > 0,
    latest: {
      version,
      tagName,
      publishedAt: typeof payload.published_at === 'string' ? payload.published_at : null,
      pageUrl: typeof payload.html_url === 'string' ? payload.html_url : RELEASES_PAGE_URL,
      apkUrl,
      apkSize: typeof apk?.size === 'number' ? apk.size : null,
    },
  };
  setState({ check: result });
  return result;
}

/** 装完包进程会被系统杀掉，没机会清理，所以每次下载前先把目录里的旧包和半成品删掉 */
function prepareDownloadDir(): Directory {
  const dir = new Directory(Paths.cache, 'update');
  dir.create({ intermediates: true, idempotent: true });
  try {
    for (const entry of dir.list()) {
      if (entry instanceof File) entry.delete();
    }
  } catch {
    // 清理失败不该挡住下载，下面 idempotent 下载会覆盖同名文件
  }
  return dir;
}

/**
 * 唤起系统安装器。ACTION_VIEW + APK mime 兼容面最广，个别 ROM 只认
 * ACTION_INSTALL_PACKAGE，所以前者找不到 activity 时再退一步试后者。
 */
async function launchInstaller(contentUri: string): Promise<IntentLauncher.IntentLauncherResult> {
  const params: IntentLauncher.IntentLauncherParams = {
    data: contentUri,
    type: APK_MIME_TYPE,
    flags: FLAG_GRANT_READ_URI_PERMISSION,
  };
  try {
    return await IntentLauncher.startActivityAsync(ACTION_VIEW, params);
  } catch {
    return await IntentLauncher.startActivityAsync(ACTION_INSTALL_PACKAGE, params);
  }
}

/**
 * 下载 APK 到应用私有缓存目录并唤起系统安装器，返回给用户看的结果文案。
 * 仅 Android 可用；iOS 装不了 APK，调用方应该走「打开发布页面」。
 */
export async function downloadAndInstallApk(latest: LatestRelease): Promise<string> {
  if (Platform.OS !== 'android') {
    throw new Error('iOS 无法安装 APK，请在发布页面获取对应版本');
  }
  if (!latest.apkUrl) {
    throw new Error('这个版本没有提供 APK 安装包，请到发布页面手动下载');
  }

  const dir = prepareDownloadDir();
  const target = new File(dir, `OpenJob-${latest.version}.apk`);
  setState({ percent: 0 });

  let downloaded: File;
  try {
    downloaded = await File.downloadFileAsync(latest.apkUrl, target, {
      idempotent: true,
      onProgress: ({ bytesWritten, totalBytes }) => {
        // 服务端没给 Content-Length 时 totalBytes 是 -1，此时只能显示「下载中」
        const percent =
          totalBytes > 0 ? Math.min(100, Math.round((bytesWritten / totalBytes) * 100)) : null;
        setState({ percent });
      },
    });
  } catch (error) {
    // Android 是边下边写，中断会留下半个文件，装它只会解析失败
    try {
      if (target.exists) target.delete();
    } catch {
      // 删不掉也无所谓，下一轮下载会先清目录
    }
    setState({ percent: null });
    throw new Error(`下载失败：${messageOf(error)}`);
  }

  setState({ percent: null });

  const result = await launchInstaller(downloaded.contentUri);
  // 装成功时本进程会被替换掉，基本走不到这里；能返回说明用户退出了安装器
  if (result.resultCode === IntentLauncher.ResultCode.Canceled) {
    return '已取消安装。若系统提示需要允许安装未知应用，请授权后重试';
  }
  return '已唤起系统安装器';
}
