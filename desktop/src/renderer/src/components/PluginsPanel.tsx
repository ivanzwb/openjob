import { useCallback, useEffect, useState } from 'react';
import type { PluginInstallResult, PluginInventoryView, PluginTrust } from '@core/ipc';
import type { InstalledPlugin } from '@core/plugins/clientView';
import { disableCodePlugin, enableCodePlugin } from '../codePlugins/runtime';
import { invoke } from '../ipc';

type CodePluginInfo = Awaited<ReturnType<typeof invoke<'codePlugin:list'>>>[number];

/** 权限 → 用户能看懂的说明。启用确认框里展示的就是这些话。 */
const PERMISSION_LABEL: Record<string, string> = {
  'llm:complete': '调用模型补全（经统一网关与审计）',
  'evidence:read-confirmed': '读取你已确认的个人证据（只读）',
  'repository:read': '读取已链接的代码仓库（只读）',
  'artifact:read': '读取简历、表格等附件',
  'microphone:read': '使用麦克风（语音作答）',
};

const TYPE_LABEL: Record<InstalledPlugin['type'], string> = {
  'role-pack': '岗位包',
  'industry-pack': '行业包',
  capability: '能力',
};

const TRUST_LABEL: Record<PluginTrust, string> = {
  'first-party': '官方签名',
  'unknown-signer': '第三方签名',
  unsigned: '未签名',
  tampered: '已被改动',
};

/**
 * 装不上的原因要说人话。
 *
 * 这份清单是「装了却没生效」唯一的出口——没有它，用户能看到的只有「岗位列表里没有它」，
 * 而这条线索指向不了任何可做的动作。
 */
const REJECTION_LABEL: Record<string, string> = {
  'directory-mismatch': '目录名与包内声明的 id@version 不一致',
  'invalid-package': '包格式或声明不合法',
  tampered: '内容与签名不符，可能被改动过',
  unsigned: '没有签名',
  'untrusted-signer': '签名者不受信任，需要重新安装并确认来源',
  duplicate: '与已有插件的 id@version 重复',
  unreadable: '读不出来',
};

const INSTALL_FAILURE_LABEL: Record<string, string> = {
  'unreadable-bundle': '文件读不出来',
  'invalid-bundle': '不是有效的插件包文件',
  'invalid-package': '包内容不合法',
  tampered: '内容与签名不符，已拒绝安装',
  unsigned: '这个包没有签名，无法确认来源',
  'untrusted-signer': '签名者不在信任列表',
  'reserved-id': '与随应用发布的插件冲突',
  'already-installed': '这个版本已经装过了',
};

function Badge({ children, tone }: { children: string; tone: string }): React.JSX.Element {
  return <span className={`rounded px-1.5 py-0.5 text-[10px] ${tone}`}>{children}</span>;
}

export function PluginsPanel(): React.JSX.Element {
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [inventory, setInventory] = useState<PluginInventoryView | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [codePlugins, setCodePlugins] = useState<CodePluginInfo[]>([]);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setInstalled(await invoke('plugin:listInstalled', undefined));
    setInventory(await invoke('plugin:inventory', undefined));
    setCodePlugins(await invoke('codePlugin:list', undefined));
  }, []);

  useEffect(() => {
    void invoke('plugin:listInstalled', undefined).then(setInstalled);
    void invoke('plugin:inventory', undefined).then(setInventory);
  }, []);

  const external = new Map(
    (inventory?.installed ?? []).map((item) => [`${item.id}@${item.version}`, item.trust]),
  );

  const report = useCallback(
    (result: PluginInstallResult | null): void => {
      if (result === null) return;
      setMessage(
        result.ok
          ? `已安装 ${result.id} ${result.version}（${TRUST_LABEL[result.trust]}）`
          : `安装失败：${INSTALL_FAILURE_LABEL[result.code] ?? result.code}\n${result.detail}`,
      );
    },
    [],
  );

  const install = useCallback(
    async (trustUnknownSigner: boolean) => {
      setBusy(true);
      setMessage(null);
      try {
        const result = await invoke('plugin:install', { trustUnknownSigner });
        report(result);
        // 陌生签名者被拒时给出一次显式确认的机会，而不是让用户面对一条无从下手的报错
        if (result && !result.ok && result.code === 'untrusted-signer') {
          const proceed = window.confirm(
            '这个包的签名者不在信任列表，无法确认它来自谁。\n\n' +
              '包内容本身是完整的（没有被改动），但只有你自己能判断发布者可不可信。\n\n' +
              '仍然安装？',
          );
          if (proceed) report(await invoke('plugin:install', { trustUnknownSigner: true }));
        }
        await refresh();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [refresh, report],
  );

  const uninstall = useCallback(
    async (id: string, version: string) => {
      if (!window.confirm(`卸载 ${id} ${version}？\n\n已经用过它的战役会保留历史结果，但不能再重跑。`)) {
        return;
      }
      setBusy(true);
      try {
        await invoke('plugin:uninstall', { id, version });
        setMessage(`已卸载 ${id} ${version}`);
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const rejected = inventory?.rejected ?? [];

  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-sm font-medium text-[var(--color-muted)]">插件</h3>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          岗位包决定面试考什么、怎么评分；能力插件决定可以用哪些工具。随应用发布的那些卸不掉，
          单独下载的插件包装进来之后与它们同等对待。插件包一律是纯数据，装进来的东西不会在本机执行。
        </p>
      </div>

      <div className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-xs">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void install(false)}
            disabled={busy}
            className="rounded border border-[var(--color-border)] px-3 py-1.5 disabled:opacity-40 hover:text-[var(--color-fg)]"
          >
            从文件安装…
          </button>
          <span className="text-[var(--color-muted)]">
            已装 {installed.length} 个{external.size > 0 && `，其中 ${external.size} 个是单独安装的`}
          </span>
        </div>

        <ul className="space-y-1.5 border-t border-[var(--color-border)] pt-3">
          {installed.map((plugin) => {
            const key = `${plugin.id}@${plugin.version}`;
            const trust = external.get(key);
            return (
              <li key={key} className="flex items-center gap-2">
                <span className="text-[var(--color-fg)]">{plugin.displayName}</span>
                <Badge tone="bg-[var(--color-bg)] text-[var(--color-muted)]">
                  {TYPE_LABEL[plugin.type]}
                </Badge>
                <span className="text-[var(--color-muted)]">{plugin.version}</span>
                {trust === undefined ? (
                  <Badge tone="bg-[var(--color-bg)] text-[var(--color-muted)]">随应用发布</Badge>
                ) : (
                  <Badge
                    tone={
                      trust === 'first-party'
                        ? 'bg-emerald-500/10 text-emerald-400'
                        : 'bg-amber-500/10 text-amber-400'
                    }
                  >
                    {TRUST_LABEL[trust]}
                  </Badge>
                )}
                {trust !== undefined && (
                  <button
                    type="button"
                    onClick={() => void uninstall(plugin.id, plugin.version)}
                    disabled={busy}
                    className="ml-auto text-[var(--color-muted)] hover:text-red-400 disabled:opacity-40"
                  >
                    卸载
                  </button>
                )}
                {plugin.main !== null && (
                  <button
                    type="button"
                    onClick={() => {
                      setMessage(null);
                      setConfirmingId(confirmingId === key ? null : key);
                    }}
                    disabled={busy}
                    className={`ml-auto text-[var(--color-muted)] hover:text-[var(--color-fg)] disabled:opacity-40 ${trust !== undefined ? '' : 'ml-auto'}`}
                  >
                    {codePlugins.find((item) => item.id === plugin.id)?.enabled ? '停用' : '启用…'}
                  </button>
                )}
              </li>
            );
          })}
        </ul>

        {confirmingId !== null && (
          <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
            <p className="text-[var(--color-fg)]">
              启用「{codePlugins.find((item) => `${item.id}@${item.version}` === confirmingId)?.displayName}」
              需要确认以下权限：
            </p>
            <ul className="list-disc space-y-0.5 pl-5 text-[var(--color-muted)]">
              {(codePlugins.find((item) => `${item.id}@${item.version}` === confirmingId)?.permissions ?? []).map(
                (permission) => (
                  <li key={permission}>
                    <code>{permission}</code>
                    {PERMISSION_LABEL[permission] ? ` —— ${PERMISSION_LABEL[permission]}` : ''}
                  </li>
                ),
              )}
            </ul>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                className="rounded bg-amber-500/20 px-2 py-1 hover:bg-amber-500/30 disabled:opacity-40"
                onClick={async () => {
                  const info = codePlugins.find((item) => `${item.id}@${item.version}` === confirmingId);
                  setBusy(true);
                  try {
                    await enableCodePlugin(confirmingId);
                    setMessage(`已启用 ${info?.displayName ?? confirmingId}`);
                  } finally {
                    setBusy(false);
                    setConfirmingId(null);
                    void refresh();
                  }
                }}
              >
                确认启用
              </button>
              <button
                type="button"
                className="rounded px-2 py-1 text-[var(--color-muted)] hover:text-[var(--color-fg)]"
                onClick={() => setConfirmingId(null)}
              >
                取消
              </button>
            </div>
          </div>
        )}

        {codePlugins.some((item) => item.enabled) && (
          <div className="space-y-1.5 border-t border-[var(--color-border)] pt-3">
            <p className="text-[var(--color-muted)]">已启用的代码插件：</p>
            {codePlugins
              .filter((item) => item.enabled)
              .map((item) => (
                <div key={item.id} className="flex items-center gap-2 text-xs">
                  <span className="text-[var(--color-fg)]">{item.displayName}</span>
                  <span className="text-[var(--color-muted)]">
                    {item.permissions.map((permission) => PERMISSION_LABEL[permission] ?? permission).join('；')}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    className="ml-auto text-[var(--color-muted)] hover:text-red-400 disabled:opacity-40"
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await disableCodePlugin(item.id);
                        setMessage(`已停用 ${item.displayName}`);
                      } finally {
                        setBusy(false);
                        void refresh();
                      }
                    }}
                  >
                    停用
                  </button>
                </div>
              ))}
          </div>
        )}

        {rejected.length > 0 && (
          <div className="space-y-1.5 border-t border-[var(--color-border)] pt-3">
            <p className="text-amber-400">以下插件装在本机但没有生效：</p>
            {rejected.map((item) => (
              <div key={item.dir} className="space-y-0.5">
                <div className="flex gap-2">
                  <span className="break-all text-[var(--color-fg)]">{item.dir}</span>
                  <span className="shrink-0 text-[var(--color-muted)]">
                    {REJECTION_LABEL[item.reason] ?? item.reason}
                  </span>
                </div>
                <p className="break-all text-[10px] text-[var(--color-muted)]">{item.detail}</p>
              </div>
            ))}
          </div>
        )}

        {message && (
          <p className="whitespace-pre-line border-t border-[var(--color-border)] pt-3 text-[11px] text-[var(--color-muted)]">
            {message}
          </p>
        )}
      </div>
    </section>
  );
}
