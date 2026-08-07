import { useEffect, useState } from 'react';
import type { UpdateConfig } from '@shared/config';
import type { UpdateStatus } from '@shared/ipc';
import { invoke, onEvent } from '../ipc';

const STATE_LABEL: Record<UpdateStatus['state'], string> = {
  idle: '尚未检查',
  disabled: '未启用',
  checking: '检查中…',
  upToDate: '已是最新',
  available: '发现新版本',
  downloading: '下载中',
  downloaded: '已下载，待重启',
  error: '检查失败',
};

const STATE_TONE: Record<UpdateStatus['state'], string> = {
  idle: 'text-[var(--color-muted)]',
  disabled: 'text-[var(--color-muted)]',
  checking: 'text-sky-300',
  upToDate: 'text-emerald-400',
  available: 'text-sky-300',
  downloading: 'text-sky-300',
  downloaded: 'text-emerald-400',
  error: 'text-red-400',
};

export function UpdatePanel({
  value,
  onChange,
}: {
  value: UpdateConfig;
  onChange: (patch: Partial<UpdateConfig>) => void;
}): React.JSX.Element {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' });
  const [version, setVersion] = useState('');

  useEffect(() => {
    void invoke('update:status', undefined).then(setStatus);
    void invoke('app:getVersion', undefined).then(setVersion);
    return onEvent('update:status', setStatus);
  }, []);

  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-sm font-medium text-[var(--color-muted)]">自动更新</h3>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          项目不绑定固定发布地址。填入你自己托管的目录（里面要有 electron-builder
          产出的 latest.yml 和安装包），留空则完全不联网检查。
        </p>
      </div>

      <div className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <label className="block space-y-1">
          <span className="text-xs text-[var(--color-muted)]">更新源 URL</span>
          <input
            value={value.feedUrl}
            onChange={(e) => onChange({ feedUrl: e.target.value })}
            placeholder="https://example.com/openjob/"
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </label>

        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={value.checkOnStartup}
            onChange={(e) => onChange({ checkOnStartup: e.target.checked })}
          />
          启动后静默检查一次
        </label>

        <div className="flex items-center gap-3 border-t border-[var(--color-border)] pt-3 text-xs">
          <button
            type="button"
            onClick={() => void invoke('update:check', undefined).then(setStatus)}
            disabled={status.state === 'checking' || status.state === 'downloading'}
            className="rounded border border-[var(--color-border)] px-3 py-1.5 disabled:opacity-40"
          >
            立即检查
          </button>

          {status.state === 'downloaded' && (
            <button
              type="button"
              onClick={() => void invoke('update:install', undefined)}
              className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-white"
            >
              重启安装
            </button>
          )}

          <span className={STATE_TONE[status.state]}>
            {STATE_LABEL[status.state]}
            {status.state === 'downloading' && status.percent !== undefined && ` ${status.percent}%`}
            {status.version && status.state !== 'upToDate' && ` ${status.version}`}
          </span>

          <span className="ml-auto text-[var(--color-muted)]">当前 v{version}</span>
        </div>

        {status.message && (
          <p className="text-[11px] text-[var(--color-muted)]">{status.message}</p>
        )}
      </div>
    </section>
  );
}
