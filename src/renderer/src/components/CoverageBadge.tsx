import type { CoverageType } from '@shared/enums';

const STYLES: Record<
  CoverageType,
  { label: string; className: string; hint: string }
> = {
  deepDive: {
    label: '必深挖',
    className: 'border-red-800/60 bg-red-950/40 text-red-300',
    hint: '简历写了 + JD 要求，要扛得住追问',
  },
  gap: {
    label: '短板',
    className: 'border-amber-800/60 bg-amber-950/40 text-amber-300',
    hint: 'JD 要求但简历没有，答出框架不露怯',
  },
  landmine: {
    label: '雷区',
    className: 'border-purple-800/60 bg-purple-950/40 text-purple-300',
    hint: '简历写了但 JD 没提，容易被顺嘴问崩',
  },
  extra: {
    label: '加分项',
    className: 'border-slate-700 bg-slate-900/50 text-slate-400',
    hint: '有余力再看',
  },
};

export function CoverageBadge({ type }: { type: CoverageType }): React.JSX.Element {
  const s = STYLES[type];
  return (
    <span
      title={s.hint}
      className={`inline-flex shrink-0 rounded border px-1.5 py-0.5 text-[11px] leading-none ${s.className}`}
    >
      {s.label}
    </span>
  );
}
