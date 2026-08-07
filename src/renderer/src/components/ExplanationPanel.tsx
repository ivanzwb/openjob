import { useEffect, useState } from 'react';
import type { Explanation } from '@shared/entities';
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
}: {
  nodeId: string;
  nodeName: string;
  defaultTier?: ExplanationTier;
  fallbackMode?: boolean;
}): React.JSX.Element {
  const [tier, setTier] = useState<ExplanationTier>(defaultTier);
  const [content, setContent] = useState<Explanation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

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
          <div className="prose prose-invert max-w-none whitespace-pre-wrap text-sm leading-relaxed">
            {content.contentMd}
          </div>
          <div className="flex gap-2 pt-2">
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
          </div>
        </>
      )}
    </div>
  );
}
