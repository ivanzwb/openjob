import type { AutoChange } from '@shared/sync';

export const REPO_FILE_TABLE = 'repo_file';

export function partitionRepoFileChanges(changes: AutoChange[]): {
  other: AutoChange[];
  repoFile: AutoChange[];
} {
  const other: AutoChange[] = [];
  const repoFile: AutoChange[] = [];
  for (const change of changes) {
    // 删除必须跟其它表同一批排序落库：repo 删在 repo_file 之后。
    // 若把 repo_file 的 delete 拆到第二批，第一批删 repo 时子行还在，会 FOREIGN KEY constraint failed。
    if (change.table === REPO_FILE_TABLE && change.kind !== 'delete') {
      repoFile.push(change);
    } else {
      other.push(change);
    }
  }
  return { other, repoFile };
}
