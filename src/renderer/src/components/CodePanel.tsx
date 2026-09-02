import { useEffect, useRef, useState } from 'react';
import type { CodeLocation } from './MarkdownContent';
import { invoke } from '../ipc';
import { highlightToHtml, langForPath } from '../lib/highlight';
import { AnnotationTools } from './AnnotationTools';

function CodePanelBody({
  repoId,
  location,
  onAnnotationChange,
}: {
  repoId: string;
  location: CodeLocation;
  onAnnotationChange?: () => void;
}): React.JSX.Element {
  const [content, setContent] = useState<string>('');
  const [html, setHtml] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ startLine: number; endLine: number; totalLines: number } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [codeRefId, setCodeRefId] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    void invoke('repo:readFile', {
      repoId,
      filePath: location.filePath,
      startLine: location.startLine,
      endLine: location.endLine,
    })
      .then(async (res) => {
        if (cancelled) return;
        setContent(res.content);
        setMeta({ startLine: res.startLine, endLine: res.endLine, totalLines: res.totalLines });

        // 有了稳定的 code_ref id，这段位置才能被收藏和加笔记
        void invoke('codeRef:ensure', {
          repoId,
          filePath: location.filePath,
          startLine: res.startLine,
          endLine: res.endLine,
        }).then((ref) => {
          if (!cancelled) setCodeRefId(ref.id);
        });

        const highlighted = await highlightToHtml(
          res.content,
          langForPath(location.filePath),
          res.startLine,
        );
        if (!cancelled) setHtml(highlighted);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setContent('');
        setHtml(null);
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
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-auto p-3">
        {loading && <p className="text-xs text-[var(--color-muted)]">加载中…</p>}
        {error && <p className="text-xs text-red-400">{error}</p>}
        {!loading && !error && html && (
          // shiki 的输出是自己生成的 HTML，不含用户内容以外的可执行片段
          <div
            className="shiki-host font-mono text-xs leading-4"
            data-code-panel=""
            data-line-numbers=""
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
        {!loading && !error && !html && meta && (
          <pre className="font-mono text-xs leading-4 text-[var(--color-fg)]">
            {content.split('\n').map((line, index) => (
              <span key={meta.startLine + index} className="block min-h-4">
                <span className="inline-block w-14 select-none pr-4 text-right text-[var(--color-muted)]">
                  {meta.startLine + index}
                </span>
                {line || ' '}
              </span>
            ))}
          </pre>
        )}
      </div>

      {codeRefId && (
        <div className="shrink-0 border-t border-[var(--color-border)] px-3 py-2">
          <AnnotationTools
            targetType="codeRef"
            targetId={codeRefId}
            scopeRef={bodyRef}
            onChange={onAnnotationChange}
          />
        </div>
      )}
    </>
  );
}

export function CodePanel({
  repoId,
  location,
  onAnnotationChange,
}: {
  repoId: string;
  location: CodeLocation | null;
  onAnnotationChange?: () => void;
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
        onAnnotationChange={onAnnotationChange}
      />
    </div>
  );
}
