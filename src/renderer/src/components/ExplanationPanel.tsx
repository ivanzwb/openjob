import { useCallback, useEffect, useState } from 'react';
import type { Annotation, Explanation } from '@shared/entities';
import type { ExplanationTier } from '@shared/enums';
import { invoke } from '../ipc';

const TIERS: { id: ExplanationTier; label: string }[] = [
  { id: 'oneliner', label: '一句话' },
  { id: 'spoken', label: '口语稿' },
  { id: 'deep', label: '深挖' },
];

export function ExplanationPanel({
  nodeId,
  nodeName,
  defaultTier = 'spoken',
  fallbackMode = false,
  onComplete,
}: {
  nodeId: string;
  nodeName: string;
  defaultTier?: ExplanationTier;
  fallbackMode?: boolean;
  onComplete?: () => void;
}): React.JSX.Element {
  const [tier, setTier] = useState<ExplanationTier>(defaultTier);
  const [content, setContent] = useState<Explanation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selection, setSelection] = useState('');
  const [noteText, setNoteText] = useState('');

  const loadAnnotations = useCallback(() => {
    void invoke('annotation:list', { targetType: 'node', targetId: nodeId }).then((list) =>
      setAnnotations(list.filter((a) => a.kind === 'highlight' || a.kind === 'note')),
    );
  }, [nodeId]);

  useEffect(loadAnnotations, [loadAnnotations]);

  // 划词后立刻取一次，等按钮点下去时 selection 往往已经被点击清掉了
  const captureSelection = (): void => {
    setSelection(window.getSelection()?.toString().trim() ?? '');
  };

  const addAnnotation = async (
    kind: 'highlight' | 'note',
    payload: { selectedText?: string; noteMd?: string },
  ): Promise<void> => {
    await invoke('annotation:create', {
      targetType: 'node',
      targetId: nodeId,
      kind,
      ...payload,
    });
    loadAnnotations();
  };

  const removeAnnotation = async (annotationId: string): Promise<void> => {
    await invoke('annotation:delete', { id: annotationId });
    loadAnnotations();
  };

  const load = async (t: ExplanationTier): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const cached = await invoke('explain:get', { nodeId, tier: t });
      if (cached) {
        setContent(cached);
        return;
      }
      const generated = fallbackMode
        ? await invoke('explain:fallback', { nodeId })
        : await invoke('explain:generate', { nodeId, tier: t });
      setContent(generated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const t = fallbackMode ? 'oneliner' : tier;
        const cached = await invoke('explain:get', { nodeId, tier: t });
        if (cancelled) return;
        if (cached) {
          setContent(cached);
          return;
        }
        const generated = fallbackMode
          ? await invoke('explain:fallback', { nodeId })
          : await invoke('explain:generate', { nodeId, tier: t });
        if (!cancelled) setContent(generated);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nodeId, tier, fallbackMode]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{nodeName}</h3>
        {!fallbackMode && (
          <div className="flex gap-1">
            {TIERS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setTier(t.id);
                  setSaved(false);
                  void load(t.id);
                }}
                className={`rounded px-2 py-0.5 text-xs ${
                  tier === t.id
                    ? 'bg-[var(--color-accent)] text-white'
                    : 'border border-[var(--color-border)] text-[var(--color-muted)]'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {loading && <p className="text-sm text-[var(--color-muted)]">生成讲解中…</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
      {content && !loading && (
        <>
          <div
            onMouseUp={captureSelection}
            className="prose prose-invert max-w-none whitespace-pre-wrap text-sm leading-relaxed"
          >
            {content.contentMd}
          </div>
          {selection && (
            <div className="flex items-center gap-2 rounded border border-amber-900/50 bg-amber-950/20 px-2 py-1">
              <span className="min-w-0 flex-1 truncate text-xs text-amber-100/90">
                「{selection}」
              </span>
              <button
                type="button"
                onClick={() => {
                  void addAnnotation('highlight', { selectedText: selection });
                  setSelection('');
                }}
                className="shrink-0 text-xs text-amber-300 hover:underline"
              >
                高亮
              </button>
              <button
                type="button"
                onClick={() => setSelection('')}
                className="shrink-0 text-xs text-[var(--color-muted)]"
              >
                取消
              </button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <button
              type="button"
              onClick={() => {
                void invoke('speech:saveFromNode', {
                  nodeId,
                  contentMd: content.contentMd,
                  tier: fallbackMode ? 'oneliner' : tier,
                }).then(() => setSaved(true));
              }}
              className="text-xs text-sky-400 hover:underline"
            >
              {saved ? '已存入话术库' : '存入话术库'}
            </button>
            {onComplete && (
              <button
                type="button"
                onClick={onComplete}
                className="ml-auto rounded bg-[var(--color-accent)] px-3 py-1 text-xs font-medium"
              >
                标记完成
              </button>
            )}
          </div>

          <div className="space-y-2 border-t border-[var(--color-border)] pt-3">
            <div className="flex gap-2">
              <input
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                placeholder="写条笔记，只有自己写下的才记得住"
                className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs"
              />
              <button
                type="button"
                disabled={!noteText.trim()}
                onClick={() => {
                  void addAnnotation('note', { noteMd: noteText.trim() });
                  setNoteText('');
                }}
                className="shrink-0 rounded border border-[var(--color-border)] px-2 py-1 text-xs disabled:opacity-40"
              >
                记笔记
              </button>
            </div>
            {annotations.length > 0 && (
              <ul className="space-y-1">
                {annotations.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-start justify-between gap-2 rounded bg-black/20 px-2 py-1 text-xs"
                  >
                    <span className="min-w-0">
                      <span className="mr-1 text-[10px] text-[var(--color-muted)]">
                        {a.kind === 'highlight' ? '高亮' : '笔记'}
                      </span>
                      {a.kind === 'highlight' ? a.selectedText : a.noteMd}
                    </span>
                    <button
                      type="button"
                      onClick={() => void removeAnnotation(a.id)}
                      className="shrink-0 text-[var(--color-muted)] hover:text-red-400"
                    >
                      删
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
