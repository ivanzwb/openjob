import { useEffect, useState } from 'react';
import type { CodeLocation } from './MarkdownContent';
import { invoke } from '../ipc';

function CodePanelBody({
  repoId,
  location,
}: {
  repoId: string;
  location: CodeLocation;
}): React.JSX.Element {
  const [content, setContent] = useState<string>('');
  const [meta, setMeta] = useState<{ startLine: number; endLine: number; totalLines: number } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void invoke('repo:readFile', {
      repoId,
      filePath: location.filePath,
      startLine: location.startLine,
      endLine: location.endLine,
    })
      .then((res) => {
        if (cancelled) return;
        setContent(res.content);
        setMeta({ startLine: res.startLine, endLine: res.endLine, totalLines: res.totalLines });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setContent('');
        setMeta(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [repoId, location]);

  return (
    <>
      <header className="shrink-0 border-b border-[var(--color-border)] px-3 py-2">
        <div className="truncate font-mono text-xs text-emerald-300">{location.filePath}</div>
        {meta && (
          <div className="text-[11px] text-[var(--color-muted)]">
            L{meta.startLine}–{meta.endLine} / {meta.totalLines} 行
          </div>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {loading && <p className="text-xs text-[var(--color-muted)]">加载中…</p>}
        {error && <p className="text-xs text-red-400">{error}</p>}
        {!loading && !error && (
          <pre className="font-mono text-xs leading-5 text-[var(--color-fg)]">{content}</pre>
        )}
      </div>
    </>
  );
}

export function CodePanel({
  repoId,
  location,
}: {
  repoId: string;
  location: CodeLocation | null;
}): React.JSX.Element {
  if (!location) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-[var(--color-muted)]">
        点击回答中的 path:line 引用查看代码
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CodePanelBody
        key={`${location.filePath}:${location.startLine}:${location.endLine ?? ''}`}
        repoId={repoId}
        location={location}
      />
    </div>
  );
}
