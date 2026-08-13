import type { ReactNode } from 'react';
import { useTask } from '../ipc/taskStore';

/**
 * 按钮的进行中状态取自按 key 的全局任务仓库，而不是组件自己的 useState：
 * 页面切走再回来、列表重建，按钮仍然知道这件事还在跑，也不会被重复点两次。
 */
export function TaskButton({
  taskKey,
  onClick,
  className,
  idleClassName = '',
  runningLabel,
  disabled,
  title,
  children,
}: {
  taskKey: string;
  onClick: () => void;
  className: string;
  /** 只在空闲时附加的样式，例如靠悬停显形的删除按钮 */
  idleClassName?: string;
  runningLabel: string;
  disabled?: boolean;
  title?: string;
  children: ReactNode;
}): React.JSX.Element {
  const { running } = useTask(taskKey);
  return (
    <button
      type="button"
      title={title}
      disabled={running || disabled}
      onClick={onClick}
      className={`${className} ${running ? '' : idleClassName}`}
    >
      {running ? runningLabel : children}
    </button>
  );
}
