import { useCallback, useEffect, useState } from 'react';
import type { CampaignOverview } from '@shared/ipc';
import { invoke } from '../ipc';

export function Overview({
  onOpenCampaign,
}: {
  onOpenCampaign: (id: string) => void;
}): React.JSX.Element {
  const [data, setData] = useState<CampaignOverview | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    void invoke('campaign:getOverview', undefined)
      .then(setData)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (loading || !data) {
    return <p className="p-6 text-sm text-[var(--color-muted)]">加载总览…</p>;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <header>
        <h2 className="text-lg font-semibold">备考总览</h2>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          跨 Campaign 累积的真题先验与薄弱点一览
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ['Campaign', String(data.campaignCount)],
          ['进行中', String(data.activeCampaignCount)],
          ['话术', String(data.totalSpeechSnippets)],
          ['盲区题', String(data.totalBlindSpots)],
        ].map(([label, value]) => (
          <div
            key={label}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
          >
            <div className="text-2xl font-semibold">{value}</div>
            <div className="text-xs text-[var(--color-muted)]">{label}</div>
          </div>
        ))}
      </div>

      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h3 className="text-sm font-medium">平均掌握度</h3>
        <p className="mt-2 text-3xl font-semibold text-[var(--color-accent)]">
          {data.avgMastery.toFixed(1)}
          <span className="text-base text-[var(--color-muted)]"> / 5</span>
        </p>
      </section>

      {data.priorByCompany.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">真题先验（按公司）</h3>
          <ul className="space-y-2">
            {data.priorByCompany.map((row) => (
              <li
                key={row.company}
                className="flex items-center justify-between rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
              >
                <span>{row.company}</span>
                <span className="text-xs text-[var(--color-muted)]">
                  {row.reportCount} 篇面经 · {row.campaignCount} 场 Campaign
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.weakNodes.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">全局薄弱考点</h3>
          <ul className="space-y-1">
            {data.weakNodes.map((n) => (
              <li key={n.nodeId}>
                <button
                  type="button"
                  onClick={() => onOpenCampaign(n.campaignId)}
                  className="flex w-full items-center justify-between rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-left text-sm hover:border-[var(--color-muted)]"
                >
                  <span>
                    {n.nodeName}
                    <span className="ml-2 text-xs text-[var(--color-muted)]">
                      {n.company} · {n.roleTitle}
                    </span>
                  </span>
                  <span className="text-xs text-amber-400">掌握 {n.mastery.toFixed(1)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-medium">全部 Campaign</h3>
        <ul className="space-y-2">
          {data.campaigns.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onOpenCampaign(c.id)}
                className="flex w-full items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-left text-sm hover:border-[var(--color-muted)]"
              >
                <span>
                  {c.company} · {c.roleTitle}
                  {c.status === 'done' && (
                    <span className="ml-2 text-xs text-emerald-400">已复盘</span>
                  )}
                </span>
                <span className="text-xs text-[var(--color-muted)]">{c.nodeCount} 考点</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
