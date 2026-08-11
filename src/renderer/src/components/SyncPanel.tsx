import { useCallback, useEffect, useState } from 'react';
import QRCodeSVG from 'react-qr-code';
import type { FieldConflict, PairingPayload, SyncRunSummary, SyncStatus } from '@shared/sync';
import type { ConflictChoice } from '@shared/sync';
import { invoke, onEvent } from '../ipc';

export function SyncPanel(): React.JSX.Element {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [pairing, setPairing] = useState<PairingPayload | null>(null);
  const [runs, setRuns] = useState<SyncRunSummary[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<FieldConflict[]>([]);
  const [choices, setChoices] = useState<Record<string, ConflictChoice>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [s, r] = await Promise.all([
      invoke('sync:status', undefined),
      invoke('sync:listRuns', { limit: 10 }),
    ]);
    setStatus(s);
    setRuns(r);
  }, []);

  useEffect(() => {
    void invoke('sync:status', undefined).then(setStatus);
    void invoke('sync:listRuns', { limit: 10 }).then(setRuns);

    const offPaired = onEvent('sync:paired', () => {
      void refresh();
      setPairing(null);
      setMessage('新设备已配对');
    });
    const offFinished = onEvent('sync:finished', (p) => {
      void refresh();
      if (p.status === 'conflict') {
        setActiveRunId(p.runId);
        void invoke('sync:listConflicts', { runId: p.runId }).then(setConflicts);
        setMessage(`同步完成，有 ${p.conflictCount} 处冲突待处理`);
      } else {
        setMessage('同步完成');
      }
    });
    return () => {
      offPaired();
      offFinished();
    };
  }, [refresh]);

  const beginPairing = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await invoke('sync:beginPairing', undefined);
      setPairing(res.payload);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const cancelPairing = async (): Promise<void> => {
    await invoke('sync:cancelPairing', undefined);
    setPairing(null);
    await refresh();
  };

  const removePeer = async (deviceId: string): Promise<void> => {
    await invoke('sync:removePeer', { deviceId });
    await refresh();
  };

  const rollback = async (backupFile: string): Promise<void> => {
    if (!confirm(`确定回退到备份 ${backupFile}？当前数据会先自动留一份快照。`)) return;
    setBusy(true);
    try {
      await invoke('sync:rollback', { backupFile });
      setMessage('已回退到所选备份');
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const conflictKey = (c: FieldConflict): string => `${c.table}\u0000${c.rowId}\u0000${c.field}`;

  const submitConflicts = async (): Promise<void> => {
    if (!activeRunId) return;
    setBusy(true);
    try {
      const payload = conflicts.map((c) => ({
        table: c.table,
        rowId: c.rowId,
        field: c.field,
        choice: choices[conflictKey(c)] ?? 'local',
      }));
      await invoke('sync:resolveConflicts', { runId: activeRunId, choices: payload });
      setActiveRunId(null);
      setConflicts([]);
      setChoices({});
      setMessage('冲突已处理');
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium text-[var(--color-muted)]">手机同步</h3>
      <p className="text-[10px] text-[var(--color-muted)]">
        同步由手机端发起。首次配对或切换电脑后，手机会自动全量同步；也可在手机上点「全量同步」。
      </p>
      <div className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-xs">
        {status && (
          <div className="space-y-1">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <span>
                服务：
                <span className={status.running ? 'text-emerald-400' : 'text-red-400'}>
                  {status.running ? `运行中 · ${status.host}:${status.port}` : '未启动'}
                </span>
              </span>
              <span>
                配对：
                <span className={status.pairingActive ? 'text-amber-300' : 'text-[var(--color-muted)]'}>
                  {status.pairingActive ? '等待扫码' : '未开启'}
                </span>
              </span>
            </div>
            {status.peers.length > 0 && (
              <ul className="mt-2 space-y-1">
                {status.peers.map((p) => (
                  <li key={p.deviceId} className="flex flex-wrap items-center gap-2">
                    <span>
                      {p.displayName} ({p.platform})
                      {p.lastSyncAt
                        ? ` · 上次同步 ${new Date(p.lastSyncAt).toLocaleString()}`
                        : ' · 尚未同步'}
                    </span>
                    <button
                      type="button"
                      onClick={() => void removePeer(p.deviceId)}
                      className="rounded border border-[var(--color-border)] px-2 py-0.5 hover:text-red-300"
                    >
                      移除
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {!pairing ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void beginPairing()}
              className="rounded border border-[var(--color-border)] px-3 py-1.5 hover:text-[var(--color-fg)] disabled:opacity-50"
            >
              生成配对码
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => void cancelPairing()}
              className="rounded border border-[var(--color-border)] px-3 py-1.5 hover:text-[var(--color-fg)]"
            >
              取消配对
            </button>
          )}
        </div>

        {pairing && (
          <div className="space-y-2 rounded border border-amber-500/30 bg-amber-500/5 p-3">
            <p className="text-amber-200">
              在手机端扫描以下信息（或手动输入）。配对码 5 分钟内有效。
            </p>
            <div className="flex flex-col items-center gap-1 rounded bg-white p-3">
              <QRCodeSVG value={JSON.stringify(pairing)} size={176} level="M" />
              <p className="text-[10px] text-[var(--color-muted)]">
                用手机端「扫描二维码配对」扫码，内容与下方 JSON 一致
              </p>
            </div>
            <p className="text-lg font-mono tracking-widest text-[var(--color-fg)]">{pairing.code}</p>
            <p className="font-mono text-[11px] text-[var(--color-muted)]">
              http://{pairing.host}:{pairing.port}
            </p>
            <pre className="max-h-32 overflow-auto rounded bg-[var(--color-bg)] p-2 text-[10px] leading-relaxed">
              {JSON.stringify(pairing, null, 2)}
            </pre>
          </div>
        )}

        {message && <p className="text-emerald-300">{message}</p>}

        {conflicts.length > 0 && activeRunId && (
          <div className="space-y-2 rounded border border-red-500/30 bg-red-500/5 p-3">
            <p className="font-medium text-red-200">待处理冲突 ({conflicts.length})</p>
            <ul className="space-y-2">
              {conflicts.map((c) => {
                const k = conflictKey(c);
                return (
                  <li key={k} className="space-y-1 rounded border border-[var(--color-border)] p-2">
                    <p className="text-[var(--color-fg)]">{c.label}</p>
                    <p className="text-[var(--color-muted)]">
                      字段：{c.field} · 本机 {String(c.localValue)} · 对端 {String(c.remoteValue)}
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setChoices((prev) => ({ ...prev, [k]: 'local' }))}
                        className={`rounded border px-2 py-0.5 ${choices[k] === 'local' ? 'border-emerald-400 text-emerald-300' : 'border-[var(--color-border)]'}`}
                      >
                        保留本机
                      </button>
                      <button
                        type="button"
                        onClick={() => setChoices((prev) => ({ ...prev, [k]: 'remote' }))}
                        className={`rounded border px-2 py-0.5 ${choices[k] === 'remote' ? 'border-sky-400 text-sky-300' : 'border-[var(--color-border)]'}`}
                      >
                        采用对端
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            <button
              type="button"
              disabled={busy}
              onClick={() => void submitConflicts()}
              className="rounded border border-[var(--color-border)] px-3 py-1.5 hover:text-[var(--color-fg)] disabled:opacity-50"
            >
              应用选择
            </button>
          </div>
        )}

        {runs.length > 0 && (
          <div className="space-y-1">
            <p className="text-[var(--color-muted)]">最近同步</p>
            <ul className="space-y-1">
              {runs.map((run) => (
                <li key={run.id} className="flex flex-wrap items-center gap-2">
                  <span>
                    {new Date(run.startedAt).toLocaleString()} · {run.peerName} · {run.status}
                    {run.conflictCount > 0 ? ` · ${run.conflictCount} 冲突` : ''}
                    {run.appliedCount > 0 ? ` · 应用 ${run.appliedCount} 条` : ''}
                  </span>
                  {run.status === 'conflict' && (
                    <button
                      type="button"
                      onClick={() => {
                        setActiveRunId(run.id);
                        void invoke('sync:listConflicts', { runId: run.id }).then(setConflicts);
                      }}
                      className="rounded border border-[var(--color-border)] px-2 py-0.5"
                    >
                      处理冲突
                    </button>
                  )}
                  {run.backupFile && (
                    <button
                      type="button"
                      onClick={() => void rollback(run.backupFile!)}
                      className="rounded border border-[var(--color-border)] px-2 py-0.5 hover:text-amber-200"
                    >
                      回退
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
