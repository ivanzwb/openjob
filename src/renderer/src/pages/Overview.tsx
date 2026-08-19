import { useCallback, useEffect, useState } from 'react';
import type { CampaignCompareResult, CampaignOverview } from '@shared/ipc';
import { invoke } from '../ipc';
import { useDataRefresh } from '../ipc/dataVersion';
import { runTask, useTask, useTaskResult } from '../ipc/taskStore';
import { PageShell } from '../components/PageShell';

export function Overview({
  onOpenCampaign,
  onOpenCampaignsList,
  onOpenScripts,
}: {
  onOpenCampaign: (id: string, nodeId?: string) => void;
  onOpenCampaignsList: () => void;
  onOpenScripts: () => void;
}): React.JSX.Element {
  const [data, setData] = useState<CampaignOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [compareA, setCompareA] = useState('');
  const [compareB, setCompareB] = useState('');
  const [compareResult, setCompareResult] = useState<CampaignCompareResult | null>(null);

  // 对比按两个 Campaign 取 key：切页回来仍显示进行中，跑完的结果也补得上
  const compareKey = `campaign:compare:${compareA}:${compareB}`;
  const { running: comparing, error: compareError } = useTask(compareKey);
  useTaskResult<CampaignCompareResult>(compareKey, setCompareResult);

  const refresh = useCallback(() => {
    void invoke('campaign:getOverview', undefined)
      .then((overview) => {
        setData(overview);
        if (overview.campaigns.length >= 2) {
          setCompareA(overview.campaigns[0]!.id);
          setCompareB(overview.campaigns[1]!.id);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useDataRefresh(refresh);

  const runCompare = (): void => {
    if (!compareA || !compareB || compareA === compareB) return;
    void runTask(compareKey, () =>
      invoke('campaign:compare', { campaignIdA: compareA, campaignIdB: compareB }),
    ).catch(() => undefined);
  };

  if (loading || !data) {
    return <p className="p-6 text-sm text-[var(--color-muted)]">加载总览…</p>;
  }

  return (
    <PageShell className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">备考总览</h2>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          跨 Campaign 累积的真题先验与薄弱点一览
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Campaign', value: String(data.campaignCount), onClick: onOpenCampaignsList },
          { label: '进行中', value: String(data.activeCampaignCount), onClick: onOpenCampaignsList },
          { label: '话术', value: String(data.totalSpeechSnippets), onClick: onOpenScripts },
          { label: '盲区题', value: String(data.totalBlindSpots), onClick: onOpenCampaignsList },
        ].map((stat) => (
          <button
            type="button"
            onClick={stat.onClick}
            key={stat.label}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-left hover:border-[var(--color-muted)]"
          >
            <div className="text-2xl font-semibold">{stat.value}</div>
            <div className="text-xs text-[var(--color-muted)]">{stat.label}</div>
          </button>
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
                  onClick={() => onOpenCampaign(n.campaignId, n.nodeId)}
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

      {data.campaigns.length >= 2 && (
        <section className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <h3 className="text-sm font-medium">Campaign 对比</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            <select
              value={compareA}
              onChange={(e) => setCompareA(e.target.value)}
              className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
            >
              {data.campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.company} · {c.roleTitle}
                </option>
              ))}
            </select>
            <select
              value={compareB}
              onChange={(e) => setCompareB(e.target.value)}
              className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
            >
              {data.campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.company} · {c.roleTitle}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            disabled={comparing || !compareA || !compareB || compareA === compareB}
            onClick={runCompare}
            className="rounded border border-[var(--color-border)] px-3 py-1 text-xs disabled:opacity-40"
          >
            {comparing ? '对比中…' : '开始对比'}
          </button>
          {compareError && <p className="text-xs text-red-400">{compareError}</p>}
          {compareResult && (
            <div className="space-y-3 border-t border-[var(--color-border)] pt-3 text-sm">
              <p className="text-xs text-[var(--color-muted)]">
                平均掌握度：{compareResult.campaignA.company}{' '}
                {compareResult.avgMasteryA.toFixed(1)} vs {compareResult.campaignB.company}{' '}
                {compareResult.avgMasteryB.toFixed(1)}
              </p>
              {compareResult.overlaps.length > 0 && (
                <div>
                  <h4 className="text-xs font-medium text-[var(--color-muted)]">
                    重叠考点（{compareResult.overlaps.length}）
                  </h4>
                  <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto">
                    {compareResult.overlaps.slice(0, 15).map((o) => (
                      <li key={o.nodeName} className="flex justify-between text-xs">
                        <span>{o.nodeName}</span>
                        <span className="text-[var(--color-muted)]">
                          {o.masteryA.toFixed(1)} / {o.masteryB.toFixed(1)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {(compareResult.onlyA.length > 0 || compareResult.onlyB.length > 0) && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <h4 className="text-xs text-[var(--color-muted)]">
                      仅 {compareResult.campaignA.company}（{compareResult.onlyA.length}）
                    </h4>
                    <ul className="mt-1 max-h-32 overflow-y-auto text-xs">
                      {compareResult.onlyA.slice(0, 8).map((n) => (
                        <li key={n.nodeName}>{n.nodeName}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h4 className="text-xs text-[var(--color-muted)]">
                      仅 {compareResult.campaignB.company}（{compareResult.onlyB.length}）
                    </h4>
                    <ul className="mt-1 max-h-32 overflow-y-auto text-xs">
                      {compareResult.onlyB.slice(0, 8).map((n) => (
                        <li key={n.nodeName}>{n.nodeName}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </div>
          )}
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
    </PageShell>
  );
}
