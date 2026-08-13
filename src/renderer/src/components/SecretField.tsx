import { useEffect, useState } from 'react';
import { invoke } from '../ipc';
import { runTask, useTask } from '../ipc/taskStore';

/**
 * API Key 输入。Key 只进不出——写入后主进程经 safeStorage 加密落盘，
 * 渲染进程只能查询「是否已配置」，永远读不回明文。
 */
export function SecretField({
  label,
  secretRef,
  placeholder,
}: {
  label: string;
  secretRef: string;
  placeholder?: string;
}): React.JSX.Element {
  const [configured, setConfigured] = useState(false);
  const [draft, setDraft] = useState('');
  // 按 secretRef 记：切页回来仍显示保存/删除进行中
  const saveKey = `config:setSecret:${secretRef}`;
  const deleteKey = `config:deleteSecret:${secretRef}`;
  const { running: saving } = useTask(saveKey);
  const { running: removing } = useTask(deleteKey);

  const refresh = (): void => {
    void invoke('config:hasSecret', { ref: secretRef }).then(setConfigured);
  };

  useEffect(refresh, [secretRef]);

  const save = (): void => {
    const value = draft.trim();
    if (!value) return;
    void runTask(saveKey, () => invoke('config:setSecret', { ref: secretRef, value }))
      .then(() => {
        setDraft('');
        refresh();
      })
      .catch(() => undefined);
  };

  const remove = (): void => {
    void runTask(deleteKey, () => invoke('config:deleteSecret', { ref: secretRef }))
      .then(refresh)
      .catch(() => undefined);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-sm">{label}</span>
        <span
          className={`rounded px-1.5 py-0.5 text-[11px] ${
            configured
              ? 'bg-emerald-950/50 text-emerald-400'
              : 'bg-[var(--color-surface)] text-[var(--color-muted)]'
          }`}
        >
          {configured ? '已配置' : '未配置'}
        </span>
      </div>
      <div className="flex gap-2">
        <input
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder ?? (configured ? '留空则保持不变' : '粘贴 API Key')}
          className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
        />
        <button
          type="button"
          onClick={save}
          disabled={saving || removing || !draft.trim()}
          className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm disabled:opacity-40"
        >
          {saving ? '保存中…' : '保存'}
        </button>
        {configured && (
          <button
            type="button"
            onClick={remove}
            disabled={saving || removing}
            className="rounded border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-muted)] hover:text-red-400 disabled:opacity-40"
          >
            {removing ? '删除中…' : '删除'}
          </button>
        )}
      </div>
    </div>
  );
}
