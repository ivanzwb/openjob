import type { ReactNode } from 'react';

/** 主内容区容器：全宽 + 统一边距；fill 时占满高度供内部自行滚动 */
export function PageShell({
  children,
  className = '',
  fill = false,
}: {
  children: ReactNode;
  className?: string;
  fill?: boolean;
}): React.JSX.Element {
  return (
    <div
      className={[
        'w-full min-w-0 px-4 py-4 lg:px-6 lg:py-5',
        fill ? 'flex h-full min-h-0 flex-col' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </div>
  );
}
