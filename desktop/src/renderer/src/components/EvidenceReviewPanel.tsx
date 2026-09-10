import { useCallback, useEffect, useState } from 'react';
import type { CandidateEvidence } from '@core/entities';
import {
  CANDIDATE_EVIDENCE_KIND_LABELS,
  describeEvidenceOrigin,
  groupEvidenceBySource,
  sortEvidenceForReview,
  summarizeEvidenceReview,
  type EvidenceDocumentLabel,
} from '@core/hostUi';
import { invoke } from '../ipc';
import { useDataRefresh } from '../ipc/dataVersion';
import { runTask, useTask, useTaskResult } from '../ipc/taskStore';
import { TaskButton } from './TaskButton';

/**
 * 一条证据的出处。
 *
 * 出处和陈述放在一起显示，而不是折叠到「查看详情」后面：确认动作的全部意义就是用户
 * 核对过原文，把原文藏起来等于让他凭印象点确认。而确认过的证据会直接作为事实进个人化
 * 回答，认错一条的代价是带着一段没发生过的经历进考场。
 */
function EvidenceCard({
  item,
  documents,
  actions,
}: {
  item: CandidateEvidence;
  documents: EvidenceDocumentLabel[];
  actions?: React.ReactNode;
}): React.JSX.Element {
  const origin = describeEvidenceOrigin(item.source, documents);

  return (
    <li className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className="rounded bg-sky-900/40 px-1.5 py-0.5 text-[10px] text-sky-300">
              {CANDIDATE_EVIDENCE_KIND_LABELS[item.kind]}
            </span>
            <span className="font-medium">{item.title}</span>
            <span className="text-[10px] text-[var(--color-muted)]">
              置信度 {Math.round(item.confidence * 100)}%
            </span>
            {item.occurredAt && (
              <span className="text-[10px] text-[var(--color-muted)]">{item.occurredAt}</span>
            )}
          </p>
          <p className="mt-0.5 text-xs text-[var(--color-muted)]">{item.statement}</p>
        </div>
        {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
      </div>

      <div className="mt-2 border-l-2 border-[var(--color-border)] pl-2">
        <p className="text-[10px] text-[var(--color-muted)]">
          出自 {origin.documentLabel} · {origin.rangeLabel}
        </p>
        {origin.broken ? (
          <p className="mt-0.5 text-[10px] text-red-400">
            引文长度与字符区间对不上，这条已经无法定位回原文，请重新抽取后再确认。
          </p>
        ) : (
          <p className="mt-0.5 text-xs italic text-[var(--color-fg)]">「{origin.quote}」</p>
        )}
      </div>
    </li>
  );
}

/**
 * 候选人证据的复核界面。
 *
 * 抽取是纯计算，落库的是逐条 propose；重复抽取会命中同一段原文并返回已有那条，
 * 所以「重新抽取」不会把用户已经确认或拒绝过的条目退回待确认。
 *
 * 拒绝走 `evidence:reject` 而不是删除，同样是为了这个：删掉之后同一段原文下次抽取
 * 又会冒出来，用户得反复拒同一条。
 */
export function EvidenceReviewPanel({ campaignId }: { campaignId: string }): React.JSX.Element {
  const [proposed, setProposed] = useState<CandidateEvidence[]>([]);
  const [confirmed, setConfirmed] = useState<CandidateEvidence[]>([]);
  const [documents, setDocuments] = useState<EvidenceDocumentLabel[]>([]);
  // 存「这份列表属于哪场备考」而不是一个 loaded 布尔：换 Campaign 时旧列表自动不算数
  const [loadedFor, setLoadedFor] = useState('');
  const [showConfirmed, setShowConfirmed] = useState(false);

  const extractKey = `campaign:${campaignId}:evidence:extract`;
  const extractTask = useTask(extractKey);

  const refresh = useCallback(() => {
    void (async () => {
      const [nextProposed, nextConfirmed, resumes, variants, reports] = await Promise.all([
        invoke('evidence:listProposed', { campaignId }),
        invoke('evidence:listConfirmed', { campaignId }),
        invoke('resume:list', undefined),
        invoke('resumeVariant:list', undefined),
        invoke('diagnosis:listReports', { campaignId }),
      ]);
      setProposed(nextProposed);
      setConfirmed(nextConfirmed);
      setDocuments([
        ...resumes.map((resume) => ({ id: resume.id, label: resume.label })),
        ...variants.map((variant) => ({ id: variant.id, label: `定制简历 · ${variant.label}` })),
        ...reports.map((report) => ({
          id: report.id,
          label: `面后复盘 · ${report.source?.title ?? report.excerpt.slice(0, 20)}`,
        })),
      ]);
      setLoadedFor(campaignId);
    })().catch(() => setLoadedFor(campaignId));
  }, [campaignId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useDataRefresh(refresh);

  useTaskResult<number>(extractKey, () => refresh());

  const extract = (): void => {
    void runTask(extractKey, async () => {
      const proposals = await invoke('evidence:extract', { campaignId });
      // 逐条落库：extract 只是纯计算，不落库的话列表里什么都不会多出来
      for (const proposal of proposals) {
        await invoke('evidence:propose', proposal);
      }
      return proposals.length;
    }).catch(() => undefined);
  };

  const act = (action: 'confirm' | 'reject', id: string): void => {
    void runTask(`evidence:${action}:${id}`, async () => {
      if (action === 'confirm') await invoke('evidence:confirm', { id });
      else await invoke('evidence:reject', { id });
      refresh();
    }).catch(() => undefined);
  };

  const loaded = loadedFor === campaignId;
  const summary = summarizeEvidenceReview({ proposed, confirmed });
  const groups = groupEvidenceBySource(proposed);

  return (
    <section className="space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">候选人证据</h3>
          <p className="mt-0.5 text-xs text-[var(--color-muted)]">
            个人化回答只会用到已确认的证据；每条都能定位回你自己写过的原文
          </p>
        </div>
        <button
          type="button"
          disabled={extractTask.running}
          onClick={extract}
          className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs disabled:opacity-40"
        >
          {extractTask.running ? '抽取中…' : proposed.length + confirmed.length > 0 ? '重新抽取' : '从简历抽取'}
        </button>
      </div>

      {!loaded ? (
        <p className="text-sm text-[var(--color-muted)]">加载中…</p>
      ) : (
        <>
          <p className="text-xs text-[var(--color-muted)]">{summary.message}</p>
          {extractTask.error && <p className="text-sm text-red-400">{extractTask.error}</p>}
          {summary.brokenCount > 0 && (
            <p className="rounded border border-red-900/50 bg-red-950/20 px-3 py-2 text-xs text-red-200">
              有 {summary.brokenCount} 条证据已经无法定位回原文，多半是抽取之后改过简历。
              重新抽取可以补上新的定位。
            </p>
          )}

          {groups.length === 0 ? (
            <p className="text-xs text-[var(--color-muted)]">
              没有待确认的证据。点「从简历抽取」会扫描简历母版、定制简历与面后复盘。
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.kind} className="space-y-2">
                <h4 className="text-xs font-medium text-[var(--color-muted)]">
                  {group.label}（{group.items.length}）
                </h4>
                <ul className="space-y-2">
                  {group.items.map((item) => (
                    <EvidenceCard
                      key={item.id}
                      item={item}
                      documents={documents}
                      actions={
                        <>
                          <TaskButton
                            taskKey={`evidence:confirm:${item.id}`}
                            onClick={() => act('confirm', item.id)}
                            runningLabel="确认中…"
                            className="rounded bg-emerald-700 px-2 py-1 text-[10px] text-white disabled:opacity-40"
                          >
                            确认
                          </TaskButton>
                          <TaskButton
                            taskKey={`evidence:reject:${item.id}`}
                            onClick={() => act('reject', item.id)}
                            runningLabel="拒绝中…"
                            className="rounded border border-[var(--color-border)] px-2 py-1 text-[10px] text-red-400 disabled:opacity-40"
                          >
                            拒绝
                          </TaskButton>
                        </>
                      }
                    />
                  ))}
                </ul>
              </div>
            ))
          )}

          {confirmed.length > 0 && (
            <div className="space-y-2 border-t border-[var(--color-border)] pt-3">
              <button
                type="button"
                onClick={() => setShowConfirmed((prev) => !prev)}
                className="text-xs text-sky-400 hover:underline"
              >
                {showConfirmed ? '收起' : `查看已确认的 ${confirmed.length} 条`}
              </button>
              {showConfirmed && (
                <ul className="space-y-2">
                  {sortEvidenceForReview(confirmed).map((item) => (
                    <EvidenceCard
                      key={item.id}
                      item={item}
                      documents={documents}
                      actions={
                        <TaskButton
                          taskKey={`evidence:reject:${item.id}`}
                          onClick={() => act('reject', item.id)}
                          runningLabel="撤回中…"
                          className="rounded border border-[var(--color-border)] px-2 py-1 text-[10px] text-red-400 disabled:opacity-40"
                        >
                          撤回确认
                        </TaskButton>
                      }
                    />
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
