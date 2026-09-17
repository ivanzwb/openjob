/**
 * 岗位侧的 git 状态探测。
 *
 * 通用的部分（找到 git、跑一条 git 命令、子进程环境怎么收紧）在 `src/main/workspace/git.ts`
 * ——那边不认岗位，插件的远端拉取也用它。这里只留「这台机器上 git 能不能用」这一件给 UI 与
 * 岗位实现用的事，避免两份 `resolveGitBinary` 各自漂移。
 */
import type { GitStatus } from '@core/ipc';
import { MISSING_GIT, gitVersion } from '../workspace/git';

export { assertGitAvailable, gitVersion, resolveGitBinary } from '../workspace/git';

/** 供 UI 提前告知用户，而不是等 clone 到一半才失败 */
export function getGitStatus(): GitStatus {
  const version = gitVersion();
  return {
    available: version !== null,
    version,
    hint: version === null ? MISSING_GIT : null,
  };
}
