import type { InterviewReportView } from '@shared/ipc';
import type { ReportSourceType } from '@shared/enums';

const SOURCE_LABEL: Record<ReportSourceType, string> = {
  selfDebrief: '自己复盘',
  pasted: '手动粘贴',
  web: '网络抓取',
};

const SOURCE_TONE: Record<ReportSourceType, string> = {
  selfDebrief: 'border-emerald-800/60 bg-emerald-950/40 text-emerald-300',
  pasted: 'border-sky-800/60 bg-sky-950/40 text-sky-300',
  web: 'border-amber-800/60 bg-amber-950/40 text-amber-300',
};

function credibilityTone(score: number): string {
  if (score >= 4) return 'text-emerald-400';
  if (score >= 3) return 'text-sky-300';
  if (score >= 2) return 'text-[var(--color-muted)]';
  return 'text-red-400';
}

function formatDate(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString();
}

/**
 * 面经列表带出处。网络来源标出链接、域名可信度和抓取时间——
 * 考察频率号称有事实锚定，用户就得能核对锚在哪。
 */
export function ReportSourceList({
  reports,
}: {
  reports: InterviewReportView[];
}): React.JSX.Element | null {
  if (reports.length === 0) return null;

  return (
    <ul className="space-y-2">
      {reports.map((r) => (
        <li
          key={r.id}
          className="space-y-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-xs"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded border px-1.5 py-0.5 text-[10px] leading-none ${SOURCE_TONE[r.sourceType]}`}
            >
              {SOURCE_LABEL[r.sourceType]}
            </span>
            <span className="text-[var(--color-muted)]">
              {r.questionCount} 题
              {r.blindSpotCount > 0 && ` · ${r.blindSpotCount} 盲区`}
            </span>
            <span className="ml-auto text-[var(--color-muted)]">{formatDate(r.createdAt)}</span>
          </div>

          {r.source ? (
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={r.source.url}
                target="_blank"
                rel="noreferrer"
                className="max-w-full truncate text-sky-400 hover:underline"
                title={r.source.url}
              >
                {r.source.title || r.source.domain}
              </a>
              <span className={credibilityTone(r.source.credibility)}>
                {r.source.domain} · 可信度 {r.source.credibility}
              </span>
              <span className="text-[var(--color-muted)]">
                抓取于 {formatDate(r.source.fetchedAt)}
              </span>
            </div>
          ) : (
            <p className="text-[var(--color-muted)]">
              {r.sourceType === 'web' ? '出处缺失' : '无网络出处（本地录入）'}
            </p>
          )}

          <p className="line-clamp-2 text-[var(--color-muted)]">{r.excerpt}</p>
        </li>
      ))}
    </ul>
  );
}
