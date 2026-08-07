import type { Citation } from '@shared/entities';
import type { EvidenceKind } from '@shared/enums';

/**
 * 信息来源角标。可信度递增：模型自身知识 < 网络检索 < 代码实证。
 * 技术内容答错比不知道更糟，用户需要一眼看出哪些结论值得再验证。
 */
const STYLES: Record<EvidenceKind, { label: string; className: string; hint: string }> = {
  model: {
    label: '模型知识',
    className: 'border-amber-800/60 bg-amber-950/40 text-amber-300',
    hint: '来自模型自身知识，未经外部验证，版本敏感内容需自行核对',
  },
  web: {
    label: '网络检索',
    className: 'border-sky-800/60 bg-sky-950/40 text-sky-300',
    hint: '基于联网检索结果，可点开出处核对',
  },
  code: {
    label: '代码实证',
    className: 'border-emerald-800/60 bg-emerald-950/40 text-emerald-300',
    hint: '结论有具体代码位置支撑',
  },
};

export function SourceBadge({ kind }: { kind: EvidenceKind }): React.JSX.Element {
  const style = STYLES[kind];
  return (
    <span
      title={style.hint}
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] leading-none ${style.className}`}
    >
      {style.label}
    </span>
  );
}

export function CitationList({ citations }: { citations: Citation[] }): React.JSX.Element | null {
  if (citations.length === 0) return null;

  return (
    <ol className="mt-3 space-y-1 border-t border-[var(--color-border)] pt-2 text-xs">
      {citations.map((c, i) => (
        <li key={`${c.url ?? c.filePath}-${i}`} className="flex gap-2">
          <span className="text-[var(--color-muted)]">[{i + 1}]</span>
          {c.url ? (
            <a
              href={c.url}
              target="_blank"
              rel="noreferrer"
              className="truncate text-sky-400 hover:underline"
            >
              {c.title || c.url}
            </a>
          ) : (
            <span className="font-mono">
              {c.filePath}:{c.startLine}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}
