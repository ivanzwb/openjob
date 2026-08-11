import { useEffect, useRef, useState } from 'react';
import type { Explanation } from '@shared/entities';
import type { ExplanationTier } from '@shared/enums';
import { invoke } from '../ipc';
import { AnnotationTools, selectionWithin } from './AnnotationTools';
import { MarkdownContent } from './MarkdownContent';

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
  onAnnotationChange,
}: {
  nodeId: string;
  nodeName: string;
  defaultTier?: ExplanationTier;
  fallbackMode?: boolean;
  onComplete?: () => void;
  onAnnotationChange?: () => void;
}): React.JSX.Element {
  const [tier, setTier] = useState<ExplanationTier>(defaultTier);
  const [content, setContent] = useState<Explanation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftMd, setDraftMd] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [elaborating, setElaborating] = useState(false);
  const [elaboration, setElaboration] = useState<{ selectedText: string; md: string } | null>(
    null,
  );
  const bodyRef = useRef<HTMLDivElement>(null);

  const activeTier = fallbackMode ? 'oneliner' : tier;
  const isUserEdited = content?.modelUsed === 'user-edit';

  const load = async (t: ExplanationTier, forceGenerate = false): Promise<void> => {
    setLoading(true);
    setError(null);
    setElaboration(null);
    try {
      if (!forceGenerate) {
        const cached = await invoke('explain:get', { nodeId, tier: t });
        if (cached) {
          setContent(cached);
          setDraftMd(cached.contentMd);
          setEditing(false);
          return;
        }
      }
      const generated = fallbackMode
        ? await invoke('explain:fallback', { nodeId })
        : await invoke('explain:generate', { nodeId, tier: t });
      setContent(generated);
      setDraftMd(generated.contentMd);
      setEditing(false);
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
      setElaboration(null);
      setEditing(false);
      try {
        const t = fallbackMode ? 'oneliner' : tier;
        const cached = await invoke('explain:get', { nodeId, tier: t });
        if (cancelled) return;
        if (cached) {
          setContent(cached);
          setDraftMd(cached.contentMd);
          return;
        }
        const generated = fallbackMode
          ? await invoke('explain:fallback', { nodeId })
          : await invoke('explain:generate', { nodeId, tier: t });
        if (!cancelled) {
          setContent(generated);
          setDraftMd(generated.contentMd);
        }
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

  const saveEdit = async (): Promise<void> => {
    if (!content) return;
    setSavingEdit(true);
    try {
      const updated = await invoke('explain:update', { id: content.id, contentMd: draftMd });
      setContent(updated);
      setDraftMd(updated.contentMd);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingEdit(false);
    }
  };

  const regenerate = async (): Promise<void> => {
    if (
      isUserEdited &&
      !confirm('你已手动修改过讲解，重新生成会覆盖当前内容。确定继续？')
    ) {
      return;
    }
    setRegenerating(true);
    try {
      await load(activeTier, true);
    } finally {
      setRegenerating(false);
    }
  };

  const elaborateSelection = async (): Promise<void> => {
    const selected = selectionWithin(bodyRef.current);
    if (!selected || !content) return;
    setElaborating(true);
    setError(null);
    try {
      const res = await invoke('explain:elaborate', {
        nodeId,
        tier: activeTier,
        selectedText: selected,
        contextMd: content.contentMd,
      });
      setElaboration({ selectedText: res.selectedText, md: res.elaborationMd });
      window.getSelection()?.removeAllRanges();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setElaborating(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{nodeName}</h3>
          {isUserEdited && (
            <p className="text-[10px] text-amber-300">已手动修订 · 重新生成会覆盖</p>
          )}
        </div>
        {!fallbackMode && (
          <div className="flex shrink-0 gap-1">
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
          {editing ? (
            <textarea
              value={draftMd}
              onChange={(e) => setDraftMd(e.target.value)}
              rows={18}
              className="w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-sm leading-relaxed outline-none focus:border-[var(--color-accent)]"
            />
          ) : (
            <div
              ref={bodyRef}
              className="prose prose-invert max-w-none text-sm leading-relaxed"
            >
              <MarkdownContent text={content.contentMd} />
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-2">
            {editing ? (
              <>
                <button
                  type="button"
                  disabled={savingEdit || !draftMd.trim()}
                  onClick={() => void saveEdit()}
                  className="rounded bg-[var(--color-accent)] px-3 py-1 text-xs font-medium disabled:opacity-40"
                >
                  {savingEdit ? '保存中…' : '保存修改'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDraftMd(content.contentMd);
                    setEditing(false);
                  }}
                  className="text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)]"
                >
                  取消
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setDraftMd(content.contentMd);
                    setEditing(true);
                  }}
                  className="text-xs text-sky-400 hover:underline"
                >
                  编辑讲解
                </button>
                <button
                  type="button"
                  disabled={regenerating}
                  onClick={() => void regenerate()}
                  className="text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)]"
                >
                  {regenerating ? '重新生成中…' : '重新生成'}
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  disabled={elaborating}
                  onClick={() => void elaborateSelection()}
                  className="text-xs text-sky-400 hover:underline disabled:opacity-40"
                  title="先在正文里划选词句，再点这里"
                >
                  {elaborating ? '细化中…' : '细化讲解'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void invoke('speech:saveFromNode', {
                      nodeId,
                      contentMd: content.contentMd,
                      tier: activeTier,
                    }).then(() => setSaved(true));
                  }}
                  className="text-xs text-sky-400 hover:underline"
                >
                  {saved ? '已存入话术库' : '存入话术库'}
                </button>
              </>
            )}
            {onComplete && !editing && (
              <button
                type="button"
                onClick={onComplete}
                className="ml-auto rounded bg-[var(--color-accent)] px-3 py-1 text-xs font-medium"
              >
                标记完成
              </button>
            )}
          </div>

          {elaboration && (
            <div className="rounded-lg border border-sky-900/50 bg-sky-950/20 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-xs font-medium text-sky-300">
                  细化：「{elaboration.selectedText.slice(0, 60)}
                  {elaboration.selectedText.length > 60 ? '…' : ''}」
                </p>
                <button
                  type="button"
                  onClick={() => setElaboration(null)}
                  className="text-[10px] text-[var(--color-muted)] hover:text-[var(--color-fg)]"
                >
                  收起
                </button>
              </div>
              <MarkdownContent text={elaboration.md} />
            </div>
          )}

          <div className="border-t border-[var(--color-border)] pt-3">
            <AnnotationTools
              targetType="explanation"
              targetId={content.id}
              scopeRef={bodyRef}
              onChange={onAnnotationChange}
            />
          </div>
        </>
      )}
    </div>
  );
}
