/**
 * 发布 tag 与安装版本号的比较。
 *
 * 事实源是 git tag（`v0.3.0`），而 expo-application 拿到的是纯版本号（`0.3.0`），
 * 两边形状不一样，比较前必须先对齐。分段比数字而不是比字符串：`0.10.0` 的字符串
 * 排序会掉到 `0.9.0` 后面，那样发了新版反而提示已是最新。
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
