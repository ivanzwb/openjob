import { useCallback, useEffect, useState } from 'react';
import QRCodeSVG from 'react-qr-code';
import type { BackupInfo, PairingPayload, SyncRunSummary, SyncStatus } from '@shared/sync';
import { backupReasonLabel } from '@shared/sync';
import { invoke, onEvent } from '../ipc';
import { bumpDataVersion } from '../ipc/dataVersion';
import { runTask } from '../ipc/taskStore';
import { TaskButton } from './TaskButton';

export function SyncPanel(): React.JSX.Element {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [pairing, setPairing] = useState<PairingPayload | null>(null);
  const [runs, setRuns] = useState<SyncRunSummary[]>([]);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [showMoreBackups, setShowMoreBackups] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [versionMismatch, setVersionMismatch] = useState<{
    peerName: string;
    peerVersion: string | null;
    desktopVersion: string;
  } | null>(null);

  const refresh = useCallback(async () => {
    const [s, r, b] = await Promise.all([
      invoke('sync:status', undefined),
      invoke('sync:listRuns', { limit: 10 }),
      invoke('sync:listBackups', undefined),
    ]);
    setStatus(s);
    setRuns(r);
    setBackups(b);
  }, []);

  useEffect(() => {
    void invoke('sync:status', undefined).then(setStatus);
    void invoke('sync:listRuns', { limit: 10 }).then(setRuns);
    void invoke('sync:listBackups', undefined).then(setBackups);

    const offPaired = onEvent('sync:paired', () => {
      void refresh();
      setPairing(null);
      setMessage('新设备已配对');
    });
    const offFinished = onEvent('sync:finished', (p) => {
      void refresh();
      bumpDataVersion();
      setVersionMismatch(null);
      if (p.overwriteCount > 0) {
        setMessage('同步完成，两端有一处内容先后改过，已自动对齐');
      } else {
        setMessage(p.appliedCount > 0 ? `同步完成，应用 ${p.appliedCount} 条` : '同步完成，无变化');
      }
    });
    const offMismatch = onEvent('sync:versionMismatch', setVersionMismatch);
    return () => {
      offPaired();
      offFinished();
      offMismatch();
    };
  }, [refresh]);

  const beginPairing = (): void => {
    void runTask('sync:beginPairing', async () => {
      const res = await invoke('sync:beginPairing', undefined);
      await refresh();
      return res.payload;
    })
      .then(setPairing)
      .catch(() => undefined);
  };

  const cancelPairing = (): void => {
    void runTask('sync:cancelPairing', async () => {
      await invoke('sync:cancelPairing', undefined);
      await refresh();
    })
      .then(() => setPairing(null))
      .catch(() => undefined);
  };

  const removePeer = (deviceId: string): void => {
    void runTask(`sync:removePeer:${deviceId}`, async () => {
      await invoke('sync:removePeer', { deviceId });
      await refresh();
    }).catch(() => undefined);
  };

  const rollback = (backupFile: string): void => {
    if (!confirm(`确定回退到备份 ${backupFile}？当前数据会先自动留一份快照。`)) return;
    void runTask(`sync:rollback:${backupFile}`, async () => {
      await invoke('sync:rollback', { backupFile });
      await refresh();
    })
      .then(() => {
        bumpDataVersion();
        setMessage('已回退到所选备份');
      })
      .catch(() => undefined);
  };

  const deleteBackupFile = (file: string): void => {
    if (!confirm(`删除快照 ${file}？只删这份备份文件，当前数据不受影响。`)) return;
    void runTask(`sync:deleteBackup:${file}`, async () => {
      await invoke('sync:deleteBackup', { backupFile: file });
      await refresh();
    })
      .then(() => setMessage('已删除所选快照'))
      .catch(() => undefined);
  };

  const cleanupOlderBackups = (): void => {
    const older = backups.slice(1);
    if (older.length === 0) return;
    if (
      !confirm(
        `将删除较早的 ${older.length} 份快照，最新的一份会保留，当前数据不受影响。`,
      )
    ) {
      return;
    }
    void runTask('sync:cleanupBackups', async () => {
      for (const b of older) {
        await invoke('sync:deleteBackup', { backupFile: b.file });
      }
      await refresh();
    })
      .then(() => {
        setShowMoreBackups(false);
        setMessage(`已清理 ${older.length} 份较早的快照`);
      })
      .catch(() => undefined);
  };

  const backupNow = (): void => {
    void runTask('sync:createBackup', async () => {
      const info = await invoke('sync:createBackup', undefined);
      await refresh();
      return info;
    })
      .then((info) => setMessage(`已留一份快照（${formatSize(info.sizeBytes)}）`))
      .catch(() => undefined);
  };

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium text-[var(--color-muted)]">手机同步</h3>
      <p className="text-[10px] text-[var(--color-muted)]">
        同步由手机端发起，两端数据自动对齐。两端改了同一行的不同字段会各自保留；
        改了同一个字段则保留较新的一份。两端在同步前各留一份自己的整库快照，
        各自独立回退，互不影响。
      </p>
      {versionMismatch && (
        <div className="space-y-1 rounded-lg border border-red-500/60 bg-red-500/10 p-3 text-xs">
          <p className="font-medium text-red-300">版本不一致，已拒绝同步</p>
          <p className="text-[var(--color-text)]">
            {versionMismatch.peerName} 是{' '}
            {versionMismatch.peerVersion ? `v${versionMismatch.peerVersion}` : '认不出版本的旧版本'}
            ，本机是 v{versionMismatch.desktopVersion}。两端版本不同时数据库结构可能已经不是一套，
            继续同步有写坏数据的风险，因此本轮没有改动任何数据。
          </p>
          <p className="text-[10px] text-[var(--color-muted)]">
            把落后的那一端升级到相同版本后会自动恢复同步，无需重新配对。
          </p>
        </div>
      )}

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
                    <TaskButton
                      taskKey={`sync:removePeer:${p.deviceId}`}
                      onClick={() => removePeer(p.deviceId)}
                      className="rounded border border-[var(--color-border)] px-2 py-0.5 hover:text-red-300 disabled:opacity-50"
                      runningLabel="移除中…"
                    >
                      移除
                    </TaskButton>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {!pairing ? (
            <TaskButton
              taskKey="sync:beginPairing"
              onClick={beginPairing}
              className="rounded border border-[var(--color-border)] px-3 py-1.5 hover:text-[var(--color-fg)] disabled:opacity-50"
              runningLabel="生成中…"
            >
              生成配对码
            </TaskButton>
          ) : (
            <TaskButton
              taskKey="sync:cancelPairing"
              onClick={cancelPairing}
              className="rounded border border-[var(--color-border)] px-3 py-1.5 hover:text-[var(--color-fg)] disabled:opacity-50"
              runningLabel="取消中…"
            >
              取消配对
            </TaskButton>
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

        {runs.length > 0 && (
          <div className="space-y-1">
            <p className="text-[var(--color-muted)]">最近同步</p>
            <ul className="space-y-1">
              {runs.map((run) => (
                <li key={run.id} className="flex flex-wrap items-center gap-2">
                  <span>
                    {new Date(run.startedAt).toLocaleString()} · {run.peerName} · {run.status}
                    {run.appliedCount > 0 ? ` · 应用 ${run.appliedCount} 条` : ''}
                  </span>
                  {run.backupFile && (
                    <TaskButton
                      taskKey={`sync:rollback:${run.backupFile}`}
                      onClick={() => rollback(run.backupFile!)}
                      className="rounded border border-[var(--color-border)] px-2 py-0.5 hover:text-amber-200 disabled:opacity-50"
                      runningLabel="回退中…"
                    >
                      回退
                    </TaskButton>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <p className="text-[var(--color-muted)]">本机整库快照</p>
            <TaskButton
              taskKey="sync:createBackup"
              onClick={backupNow}
              className="rounded border border-[var(--color-border)] px-2 py-0.5 disabled:opacity-50"
              runningLabel="备份中…"
            >
              立即备份
            </TaskButton>
          </div>
          <p className="text-[10px] text-[var(--color-muted)]">
            同步前、升级数据库结构前都会自动留一份，两端各存各的、各自回退。默认只显示最新一份，较早的可在「更多」里查看或一次性清理。
          </p>
          {backups.length === 0 ? (
            <p className="text-[var(--color-muted)]">还没有快照</p>
          ) : (
            <div className="space-y-1">
              <BackupRow
                backup={backups[0]}
                onRollback={rollback}
                onDelete={deleteBackupFile}
              />
              {backups.length > 1 && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <TaskButton
                    taskKey="sync:cleanupBackups"
                    onClick={cleanupOlderBackups}
                    className="rounded border border-[var(--color-border)] px-2 py-0.5 hover:text-red-300 disabled:opacity-50"
                    runningLabel="清理中…"
                  >
                    清理
                  </TaskButton>
                  <button
                    type="button"
                    onClick={() => setShowMoreBackups((v) => !v)}
                    className="rounded border border-[var(--color-border)] px-2 py-0.5 hover:text-[var(--color-fg)]"
                  >
                    {showMoreBackups ? '收起' : `更多（${backups.length - 1}）`}
                  </button>
                </div>
              )}
              {showMoreBackups &&
                backups.slice(1).map((b) => (
                  <BackupRow
                    key={b.file}
                    backup={b}
                    onRollback={rollback}
                    onDelete={deleteBackupFile}
                  />
                ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function BackupRow({
  backup,
  onRollback,
  onDelete,
}: {
  backup: BackupInfo;
  onRollback: (file: string) => void;
  onDelete: (file: string) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span>
        {new Date(backup.createdAt).toLocaleString()} · {backupReasonLabel(backup.reason)} ·{' '}
        {formatSize(backup.sizeBytes)}
      </span>
      <TaskButton
        taskKey={`sync:rollback:${backup.file}`}
        onClick={() => onRollback(backup.file)}
        className="rounded border border-[var(--color-border)] px-2 py-0.5 hover:text-amber-200 disabled:opacity-50"
        runningLabel="回退中…"
      >
        回退到这份
      </TaskButton>
      <TaskButton
        taskKey={`sync:deleteBackup:${backup.file}`}
        onClick={() => onDelete(backup.file)}
        className="rounded border border-[var(--color-border)] px-2 py-0.5 hover:text-red-300 disabled:opacity-50"
        runningLabel="删除中…"
      >
        删除
      </TaskButton>
    </div>
  );
}
