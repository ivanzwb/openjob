import type { ReactNode } from 'react';

/** 切换 Tab 时保持子树挂载，仅用 CSS 隐藏，避免本地状态丢失 */
export function TabPanel({
  active,
  children,
  className = '',
}: {
  active: boolean;
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={`${active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'} ${className}`.trim()}
      aria-hidden={!active}
    >
      {children}
    </div>
  );
}
