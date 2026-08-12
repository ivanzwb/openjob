import type { SQLiteDatabase } from 'expo-sqlite';
import type { Repo } from '@shared/entities';

function rowToRepo(row: {
  id: string;
  url: string;
  local_path: string;
  default_branch: string | null;
  commit_sha: string | null;
  languages: string;
  repo_map_md: string | null;
  summary_md: string | null;
  indexed_at: number | null;
  status: string;
}): Repo {
  let languages: string[] = [];
  try {
    languages = JSON.parse(row.languages) as string[];
  } catch {
    languages = [];
  }
  return {
    id: row.id,
    url: row.url,
    localPath: row.local_path,
    defaultBranch: row.default_branch,
    commitSha: row.commit_sha,
    languages,
    repoMapMd: row.repo_map_md,
    summaryMd: row.summary_md,
    indexedAt: row.indexed_at,
    status: row.status as Repo['status'],
  };
}

export function listRepos(db: SQLiteDatabase): Repo[] {
  const rows = db.getAllSync<Parameters<typeof rowToRepo>[0]>(`SELECT * FROM repo ORDER BY url`);
  return rows.map(rowToRepo);
}
