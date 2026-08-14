import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import type { UpdateStatus } from '@shared/ipc';
import { invoke, onEvent } from '../ipc';

/**
 * 标题栏里的新版提示。
 *
 * 更新面板在设置页深处，不进设置的人永远看不到检测结果，
 * 所以把「有新版 / 下载中 / 可安装」这三个用户需要知道的状态提到标题栏，
 * 其余状态（检查中、已是最新、失败）不出现，避免常驻噪音。
 */

function describe(status: UpdateStatus): string | null {
  const version = status.version ? ` v${status.version}` : '';
  switch (status.state) {
    case 'available':
      return `发现新版${version}`;
    case 'downloading':
      return `新版下载中 ${status.percent ?? 0}%`;
    case 'downloaded':
      return `新版${version} 已就绪 · 去安装`;
    default:
      return null;
  }
}

export function UpdateBadge({
  onOpenSettings,
}: {
  onOpenSettings: () => void;
}): React.JSX.Element | null {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' });

  useEffect(() => {
    void invoke('update:status', undefined).then(setStatus);
    return onEvent('update:status', setStatus);
  }, []);

  const text = describe(status);
  if (!text) return null;

  return (
    <button
      type="button"
      onClick={onOpenSettings}
      title="打开设置查看更新"
      className={`inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[11px] hover:bg-[var(--color-surface)] ${
        status.state === 'downloaded' ? 'text-emerald-400' : 'text-sky-300'
      }`}
    >
      <Download size={12} aria-hidden />
      {text}
    </button>
  );
}
