/**
 * 版本号比较，以及端间同步的版本闸门。
 *
 * 桌面端与手机端由同一个 `v*` tag 构建（见两条 release workflow 里的
 * sync-version 步骤），所以同一次发布出来的两个包版本号必然相同。反过来说，
 * 版本号不同就意味着两边的库结构、同步协议或合并规则可能已经不是一套——
 * 这种情况下同步不是「可能出错」，而是可能静默写坏数据，所以直接拒绝，
 * 让用户先把落后的那一端升上来。
 */

/** 去掉 tag 的 `v` 前缀，`v0.3.0` 与 `0.3.0` 视为同一个版本 */
export function normalizeVersion(raw: string): string {
  return raw.trim().replace(/^v/i, '');
}

/** 只取 `1.2.3` 这一段：预发布后缀（`-beta.1`）不参与数值比较 */
function segments(version: string): number[] {
  const core = normalizeVersion(version).split(/[-+]/)[0] ?? '';
  return core.split('.').map((part) => {
    const value = Number.parseInt(part, 10);
    return Number.isNaN(value) ? 0 : value;
  });
}

/** a 比 b 新返回 1，旧返回 -1，相同返回 0。段数不同时缺的位按 0 补（`1.2` === `1.2.0`） */
export function compareVersions(a: string, b: string): number {
  const left = segments(a);
  const right = segments(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** 同步失败原因里唯一需要被两端代码识别的一种，用于换成专门的提示界面 */
export const SYNC_VERSION_MISMATCH = 'versionMismatch';

/** 同步接口的错误体。`code` 只在需要客户端区别对待时才给 */
export interface SyncErrorBody {
  error: string;
  code?: typeof SYNC_VERSION_MISMATCH;
  desktopVersion?: string;
  peerVersion?: string;
}

/**
 * 两端版本是否允许同步。
 *
 * 要求补丁号也一致，而不是只比大版本：带数据库迁移的发布经常只抬补丁号，
 * 而迁移正是最容易把两端库结构拉开的东西。宁可多拦一次，也不能让 0.6.5
 * 的手机去写 0.6.6 的库。
 */
export function isSyncCompatible(a: string, b: string): boolean {
  return compareVersions(a, b) === 0;
}

/** 谁落后了。两端拿同一份文案，避免各写一句、说法还不一样 */
export function versionMismatchMessage(desktopVersion: string, peerVersion: string | null): string {
  if (!peerVersion) {
    return `手机端版本过旧，无法确认版本号（桌面端 v${desktopVersion}）。为避免写坏数据，本次不同步，请先把手机端升级到 v${desktopVersion}。`;
  }
  const behind = compareVersions(peerVersion, desktopVersion) < 0 ? '手机端' : '桌面端';
  return `版本不一致：桌面端 v${desktopVersion}，手机端 v${peerVersion}。为避免写坏数据，本次不同步，请先升级${behind}到相同版本。`;
}
