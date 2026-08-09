import { useState } from 'react';
import { invoke } from '../ipc';

export function CampaignCreate({
  onCreated,
  onCancel,
}: {
  onCreated: (id: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [company, setCompany] = useState('');
  const [roleTitle, setRoleTitle] = useState('');
  const [jdRaw, setJdRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (!company.trim() || !jdRaw.trim()) {
      setError('公司和 JD 为必填');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const c = await invoke('campaign:create', {
        company: company.trim(),
        roleTitle: roleTitle.trim() || '未命名岗位',
        jdRaw: jdRaw.trim(),
      });
      onCreated(c.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-6 p-6">
      <header>
        <h2 className="text-lg font-semibold">新建备考</h2>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          先填 JD 就能出考点清单，简历和面试日期可以之后再补
        </p>
      </header>

      <div className="space-y-4">
        <label className="block space-y-1">
          <span className="text-sm text-[var(--color-muted)]">公司 *</span>
          <input
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            placeholder="例如：字节跳动"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm text-[var(--color-muted)]">岗位</span>
          <input
            value={roleTitle}
            onChange={(e) => setRoleTitle(e.target.value)}
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            placeholder="例如：后端开发工程师"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm text-[var(--color-muted)]">岗位 JD *</span>
          <textarea
            value={jdRaw}
            onChange={(e) => setJdRaw(e.target.value)}
            rows={12}
            className="w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            placeholder="粘贴完整 JD…"
          />
        </label>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy}
          className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium disabled:opacity-40"
        >
          {busy ? '创建中…' : '创建并进入诊断'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm"
        >
          取消
        </button>
      </div>
    </div>
  );
}
