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
          默认检查官方 GitHub Release，发现新版会自动下载，装不装由你点。自己构建自己分发的，
          填上你托管的目录（里面要有 electron-builder 产出的 latest.yml 和安装包）即可改到那边。
          填 GitHub 仓库地址（可带 gh-proxy 之类的镜像前缀）也行，会自动指向该仓库最新一版的资产目录。
          不想让它自己联网就取消下面的启动检查，此后只有点「立即检查」才会发请求。
        </p>
      </div>

      <div className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <label className="block space-y-1">
          <span className="text-xs text-[var(--color-muted)]">更新源 URL（留空用官方 GitHub Release）</span>
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
            onClick={() =>
              void invoke('update:check', undefined)
                .then(setStatus)
                // IPC 层兜底：主进程任何意外抛错都落成可见的错误状态，而不是静默无反应
                .catch((err: unknown) =>
                  setStatus({
                    state: 'error',
                    message: err instanceof Error ? err.message : String(err),
                  }),
                )
            }
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
          <p className="whitespace-pre-line text-[11px] text-[var(--color-muted)]">{status.message}</p>
        )}
      </div>
    </section>
  );
}
