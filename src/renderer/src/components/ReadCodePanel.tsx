import { useEffect, useState } from 'react';
import type { Repo } from '@shared/entities';
import { RepoWorkspace } from './RepoWorkspace';
import { invoke } from '../ipc';

export function ReadCodePanel({
  repoId,
  onComplete,
}: {
  repoId: string;
  onComplete: () => void;
}): React.JSX.Element {
  const [repo, setRepo] = useState<Repo | null>(null);

  useEffect(() => {
    void invoke('repo:get', { id: repoId }).then(setRepo);
  }, [repoId]);

  if (!repo) {
    return <p className="text-sm text-[var(--color-muted)]">加载仓库…</p>;
  }

  return <RepoWorkspace repo={repo} onComplete={onComplete} />;
}
