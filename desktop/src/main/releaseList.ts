/**
 * GitHub Releases 列表查询，供自动更新「同大版本线优先」选版用。
 *
 * electron-updater 只认「最新一条 release」；要优先同 x.y 线内的补丁，得先把
 * 正式版 tag 列表拉下来自己挑。独立成模块是为了在 updater.test.ts 里 mock，
 * 不让单测去打 GitHub API。
 */

/** GitHub API 单页最多 100 条 release，够覆盖 openjob 的发布节奏 */
const PER_PAGE = 100;

export interface GitHubRelease {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
}

/**
 * 拉取某仓库的正式版（非 draft、非 prerelease）tag 列表，新的在前。
 * API 失败（断网、限流、仓库不存在）直接抛错，调用方负责回退。
 */
export async function listGitHubReleaseTags(owner: string, repo: string): Promise<string[]> {
  const res = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=${PER_PAGE}`,
    {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'openjob-updater' },
    },
  );
  if (!res.ok) {
    throw new Error(`GitHub releases API ${res.status} ${res.statusText}`);
  }
  const releases = (await res.json()) as GitHubRelease[] | null;
  if (!Array.isArray(releases)) throw new Error('GitHub releases API 返回了非数组');
  return releases
    .filter((r) => !r.draft && !r.prerelease && typeof r.tag_name === 'string')
    .map((r) => r.tag_name as string);
}
