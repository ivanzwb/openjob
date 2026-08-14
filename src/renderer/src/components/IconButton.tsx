import type { LucideIcon } from 'lucide-react';

const TONE = {
  muted: 'text-[var(--color-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-fg)]',
  danger: 'text-[var(--color-muted)] hover:bg-red-500/10 hover:text-red-400',
} as const;

const SIZE = {
  sm: { padding: 'p-1', icon: 14 },
  md: { padding: 'p-1.5', icon: 16 },
} as const;

/**
 * 纯图标按钮。`label` 是必填的：它既做 tooltip 又做无障碍名称，
 * 图标本身对读屏软件是空的，漏了就变成一个没有名字的按钮。
 * 语义不够通用、光看图标猜不出来的动作不要用这个，带上文字更好。
 */
export function IconButton({
  icon: Icon,
  label,
  onClick,
  tone = 'muted',
  size = 'md',
  disabled,
  className = '',
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  tone?: keyof typeof TONE;
  size?: keyof typeof SIZE;
  disabled?: boolean;
  className?: string;
}): React.JSX.Element {
  const { padding, icon } = SIZE[size];
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`shrink-0 rounded transition-colors disabled:opacity-40 disabled:hover:bg-transparent ${padding} ${TONE[tone]} ${className}`}
    >
      <Icon size={icon} aria-hidden />
    </button>
  );
}
