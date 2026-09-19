import { useCallback, useEffect, useState } from 'react';
import type {
  PluginCatalogEntry,
  PluginCatalogView,
  PluginInstallResult,
  PluginInventoryView,
  PluginTrust,
} from '@core/ipc';
import type { PluginType } from '@core/enums';
import { compareExactSemVer } from '@core/plugins/registry';
import {
  activateInstalledPluginRuntimes,
  disablePluginRuntime,
  enablePluginRuntime,
} from '../pluginRuntimes/runtime';
import { invoke } from '../ipc';

type PluginRuntimeInfo = Awaited<ReturnType<typeof invoke<'pluginRuntime:list'>>>[number];

/** 安装时用户要拍板的两道确认，两条安装路径（文件、更新源清单）共用同一套问答 */
interface InstallDecisions {
  trustUnknownSigner: boolean;
  confirmDataLoss: boolean;
}

/** 权限 → 用户能看懂的说明。启用确认框里展示的就是这些话。 */
const PERMISSION_LABEL: Record<string, string> = {
  'llm:complete': '调用模型补全（经统一网关与审计）',
  'evidence:read-confirmed': '读取你已确认的个人证据（只读）',
  'filesystem:workspace': '读写插件自己的目录',
  'network:fetch': '从远端下载公开仓库到插件自己的目录（只下载，不带你的凭据）',
  'network:search': '联网检索',
  'artifact:read': '读取简历、表格等附件',
  'microphone:read': '使用麦克风（语音作答）',
  'library:write': '把你选中的内容存进话术库（来源类型由插件自己起）',
};

const TYPE_LABEL: Record<PluginType, string> = {
  'role-pack': '岗位包',
  'industry-pack': '行业包',
  capability: '能力',
  plugin: '代码插件',
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
  unreadable: '读不出来',
  'isolation-violation': '静态隔离扫描未通过：插件试图访问宿主受限能力',
};

const INSTALL_FAILURE_LABEL: Record<string, string> = {
  'unreadable-bundle': '文件读不出来',
  'invalid-bundle': '不是有效的插件包文件',
  'invalid-package': '包内容不合法',
  tampered: '内容与签名不符，已拒绝安装',
  unsigned: '这个包没有签名，无法确认来源',
  'untrusted-signer': '签名者不在信任列表',
  'already-installed': '这个版本已经装过了',
  'one-plugin-limit': '本机已经装了一个插件，要先卸载它',
  'isolation-violation': '静态隔离扫描未通过，已拒绝安装',
  'confirm-data-loss': '升级前的旧战役尚未适配此岗位',
  'catalog-unavailable': '更新源里读不到插件清单',
  'bundle-not-in-catalog': '更新源里没有这个包了',
  'download-failed': '包下载失败',
  'checksum-mismatch': '下载到的内容与清单登记的摘要不符',
  'bundle-mismatch': '下载回来的包与清单登记的不是同一个',
};

const CATALOG_ERROR_LABEL: Record<NonNullable<PluginCatalogView['error']>['kind'], string> = {
  unreachable: '拉不到插件清单',
  'not-published': '更新源里还没有插件清单',
  malformed: '清单格式不对',
};

function Badge({ children, tone }: { children: string; tone: string }): React.JSX.Element {
  return <span className={`rounded px-1.5 py-0.5 text-[10px] ${tone}`}>{children}</span>;
}

function permissionSummary(permissions: string[]): string {
  return permissions.map((permission) => PERMISSION_LABEL[permission] ?? permission).join('；');
}

/**
 * 插件面板。
 *
 * `onPluginsChanged` 让宿主页面知道「本机装了哪些包」变了——角色映射那份清单跟着岗位包走，
 * 装/卸之后必须重拉，否则用户要重开设置页才能看到变化。
 */
export function PluginsPanel({
  onPluginsChanged,
}: { onPluginsChanged?: () => void } = {}): React.JSX.Element {
  const [inventory, setInventory] = useState<PluginInventoryView | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 正在装的那一条，用来只在它自己那行显示「安装中…」 */
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const [pluginRuntimes, setPluginRuntimes] = useState<PluginRuntimeInfo[]>([]);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const [catalog, setCatalog] = useState<PluginCatalogView | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setInventory(await invoke('plugin:inventory', undefined));
    setPluginRuntimes(await invoke('pluginRuntime:list', undefined));
    // 代码插件的页签由激活产生，而激活只在应用挂载与启用/停用开关时发生：装、卸、删目录
    // 之后不重新激活的话，新装的岗位包（如 software-engineering 的「源码」页）要重启才出现
    await activateInstalledPluginRuntimes();
    onPluginsChanged?.();
  }, [onPluginsChanged]);

  /**
   * 清单每次都重新拉。
   *
   * 不复用上一次的结果：这份列表要回答「有没有新版本」，它正是最该新鲜的东西；
   * 代价只是一次请求，且发生在用户打开设置时。拉不到不抛错——离线、镜像不通、
   * 还没发过插件都是常态，界面要说出原因而不是留一片空白。
   */
  const readCatalog = useCallback(async (): Promise<PluginCatalogView> => {
    try {
      return await invoke('plugin:listAvailable', undefined);
    } catch (error) {
      return {
        source: '',
        fetchedAt: Date.now(),
        entries: [],
        error: {
          kind: 'unreachable',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }, []);

  const loadCatalog = useCallback(async () => {
    setRefreshing(true);
    try {
      setCatalog(await readCatalog());
    } finally {
      setRefreshing(false);
    }
  }, [readCatalog]);

  useEffect(() => {
    void invoke('plugin:inventory', undefined).then(setInventory);
    // 与上面那条同一个形状：setState 落在 promise 回调里，不在 effect 里同步 setState
    void readCatalog().then(setCatalog);
  }, [readCatalog]);

  /**
   * 「已装」列表直接来自盘上的扫描结果。
   *
   * 不用 plugin:listInstalled：那份清单里还会带上按岗位包内嵌声明派生的能力条目
   * （`source-repository` 这种），它是运行时解析能力引用与权限契约用的，内容本来就归
   * 岗位包所有——列在这里会让「装一个包」看起来像装了两个。
   */
  const packages = inventory?.installed ?? [];

  /** 单独装的插件按 id 归并：同一个 id 的多个版本都算装了同一个插件 */
  const externalVersions = new Map<string, string[]>();
  for (const item of packages) {
    externalVersions.set(item.id, [...(externalVersions.get(item.id) ?? []), item.version]);
  }

  const report = useCallback((result: PluginInstallResult | null): void => {
    if (result === null) return;
    setMessage(
      result.ok
        ? `已安装 ${result.id} ${result.version}（${TRUST_LABEL[result.trust]}）`
        : `安装失败：${INSTALL_FAILURE_LABEL[result.code] ?? result.code}\n${result.detail}`,
    );
  }, []);

  /**
   * 安装，并把两处该问的问出来。
   *
   * 陌生签名者（包没被改动，但只有用户能判断发布者可不可信）与升级前的旧战役数据（装包
   * 本身不动旧数据，套用新岗位时才会丢）都要用户显式拍板。两条安装路径共用这一套问答，
   * 各写一份迟早会漏掉一边——漏掉的那边会静默地少一道确认。
   */
  const install = useCallback(
    async (run: (decisions: InstallDecisions) => Promise<PluginInstallResult | null>): Promise<void> => {
      const decisions: InstallDecisions = { trustUnknownSigner: false, confirmDataLoss: false };
      const attempt = async (): Promise<PluginInstallResult | null> => {
        const result = await run({ ...decisions });
        report(result);
        return result;
      };

      let result = await attempt();
      if (
        result &&
        !result.ok &&
        result.code === 'untrusted-signer' &&
        window.confirm(
          '这个包的签名者不在信任列表，无法确认它来自谁。\n\n' +
            '包内容本身是完整的（没有被改动），但只有你自己能判断发布者可不可信。\n\n' +
            '仍然安装？',
        )
      ) {
        decisions.trustUnknownSigner = true;
        result = await attempt();
      }
      if (
        result &&
        !result.ok &&
        result.code === 'confirm-data-loss' &&
        window.confirm(`${result.detail}\n\n是否仍要安装？`)
      ) {
        decisions.confirmDataLoss = true;
        await attempt();
      }
    },
    [report],
  );

  const installFromFile = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      await install(async (decisions) => invoke('plugin:install', decisions));
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [install, refresh]);

  const installFromCatalog = useCallback(
    async (entry: PluginCatalogEntry) => {
      const key = `${entry.id}@${entry.version}`;
      setBusy(true);
      setPendingKey(key);
      setMessage(null);
      try {
        await install(async (decisions) =>
          invoke('plugin:installFromCatalog', { id: entry.id, version: entry.version, ...decisions }),
        );
        await refresh();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
        setPendingKey(null);
      }
    },
    [install, refresh],
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
  const hasExternal = externalVersions.size > 0;

  /**
   * 删掉一个没通过扫描的包目录。
   *
   * 这类包不在安装清单里，走不了 plugin:uninstall（拿不到 id@version），但它们还占着盘，
   * 而且一直挂在下面的报错清单里——没有这个入口，用户就卡在「装不上也删不掉」。
   */
  const removeRejected = useCallback(
    async (dir: string): Promise<void> => {
      if (
        !window.confirm(
          `删除 ${dir}？\n\n这个包装在本机但没有生效，删掉的只是磁盘上这个目录；` +
            '已经用过它的战役会保留历史结果。',
        )
      ) {
        return;
      }
      setBusy(true);
      try {
        await invoke('plugin:removeRejectedDir', { dir });
        setMessage(`已删除 ${dir}`);
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  /**
   * 岗位包排前面。
   *
   * 基础包不带岗位，只装个能力包的话面试照样开不了；而清单按 id 排序时能力包
   * （`source-repository` 这种）正好在最前，用户第一眼看到的就是它。一个设备只能装一个
   * 插件，先装上它就得再卸一次才轮得到岗位包。
   */
  const entries = [...(catalog?.entries ?? [])].sort(
    (left, right) =>
      Number(right.type === 'role-pack') - Number(left.type === 'role-pack') ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );

  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-sm font-medium text-[var(--color-muted)]">插件</h3>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          岗位包决定面试考什么、怎么评分；能力插件决定可以用哪些工具。插件只装一个：换插件
          要先卸载现在这个。带代码入口的包（代码插件或内嵌了页面的岗位包）装上后要在启用前
          确认权限，跑在 Webview 沙箱里，拿不到主库与宿主 Node 能力。
        </p>
      </div>

      <div className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-xs">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void installFromFile()}
            disabled={busy}
            className="rounded border border-[var(--color-border)] px-3 py-1.5 disabled:opacity-40 hover:text-[var(--color-fg)]"
          >
            从文件安装…
          </button>
          <span className="text-[var(--color-muted)]">已装 {packages.length} 个</span>
        </div>

        <ul className="space-y-1.5 border-t border-[var(--color-border)] pt-3">
          {packages.length === 0 && (
            <li className="text-[var(--color-muted)]">
              还没装任何插件。岗位包是必需的——从下面的「可安装插件」里挑一个装上，面试才有内容可考。
            </li>
          )}
          {packages.map((plugin) => {
            const key = `${plugin.id}@${plugin.version}`;
            return (
              <li key={key} className="flex items-center gap-2">
                <span className="text-[var(--color-fg)]">{plugin.displayName}</span>
                <Badge tone="bg-[var(--color-bg)] text-[var(--color-muted)]">
                  {TYPE_LABEL[plugin.type]}
                </Badge>
                <span className="text-[var(--color-muted)]">{plugin.version}</span>
                <Badge
                  tone={
                    plugin.trust === 'first-party'
                      ? 'bg-emerald-500/10 text-emerald-400'
                      : 'bg-amber-500/10 text-amber-400'
                  }
                >
                  {TRUST_LABEL[plugin.trust]}
                </Badge>
                <button
                  type="button"
                  onClick={() => void uninstall(plugin.id, plugin.version)}
                  disabled={busy}
                  className="ml-auto text-[var(--color-muted)] hover:text-red-400 disabled:opacity-40"
                >
                  卸载
                </button>
                {plugin.main !== null && (
                  <button
                    type="button"
                    onClick={() => {
                      setMessage(null);
                      setConfirmingId(confirmingId === key ? null : key);
                    }}
                    disabled={busy}
                    className="text-[var(--color-muted)] hover:text-[var(--color-fg)] disabled:opacity-40"
                  >
                    {pluginRuntimes.find((item) => item.id === plugin.id)?.enabled ? '停用' : '启用…'}
                  </button>
                )}
              </li>
            );
          })}
        </ul>

        {confirmingId !== null && (
          <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
            <p className="text-[var(--color-fg)]">
              启用「{pluginRuntimes.find((item) => `${item.id}@${item.version}` === confirmingId)?.displayName}」
              需要确认以下权限：
            </p>
            <ul className="list-disc space-y-0.5 pl-5 text-[var(--color-muted)]">
              {(pluginRuntimes.find((item) => `${item.id}@${item.version}` === confirmingId)?.permissions ?? []).map(
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
                  const info = pluginRuntimes.find((item) => `${item.id}@${item.version}` === confirmingId);
                  setBusy(true);
                  try {
                    await enablePluginRuntime(confirmingId);
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

        {pluginRuntimes.some((item) => item.enabled) && (
          <div className="space-y-1.5 border-t border-[var(--color-border)] pt-3">
            <p className="text-[var(--color-muted)]">已启用的代码插件：</p>
            {pluginRuntimes
              .filter((item) => item.enabled)
              .map((item) => (
                <div key={item.id} className="flex items-center gap-2 text-xs">
                  <span className="text-[var(--color-fg)]">{item.displayName}</span>
                  <span className="text-[var(--color-muted)]">
                    {permissionSummary(item.permissions)}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    className="ml-auto text-[var(--color-muted)] hover:text-red-400 disabled:opacity-40"
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await disablePluginRuntime(item.id);
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
                  <button
                    type="button"
                    onClick={() => void removeRejected(item.dir)}
                    disabled={busy}
                    className="ml-auto shrink-0 text-[var(--color-muted)] hover:text-red-400 disabled:opacity-40"
                  >
                    删除
                  </button>
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

      <div className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-xs">
        <div className="flex items-center gap-3">
          <span className="text-[var(--color-fg)]">可安装插件</span>
          <span className="truncate text-[10px] text-[var(--color-muted)]" title={catalog?.source}>
            来自更新源：{catalog?.source ?? '读取中…'}
          </span>
          <button
            type="button"
            onClick={() => void loadCatalog()}
            disabled={refreshing || busy}
            className="ml-auto shrink-0 rounded border border-[var(--color-border)] px-3 py-1.5 disabled:opacity-40 hover:text-[var(--color-fg)]"
          >
            {refreshing ? '读取中…' : '刷新清单'}
          </button>
        </div>

        {hasExternal && (
          <p className="text-[var(--color-muted)]">
            本机已经装了 {[...externalVersions.keys()].join('、')}。插件只装一个：换插件要先卸载
            它。同一个插件的其他版本属于更新或回退，装完再把旧版本卸掉即可。
          </p>
        )}

        {catalog?.error && (
          <div className="space-y-1 border-t border-[var(--color-border)] pt-3">
            <p className="text-amber-400">{CATALOG_ERROR_LABEL[catalog.error.kind]}</p>
            <p className="whitespace-pre-line break-all text-[10px] text-[var(--color-muted)]">
              {catalog.error.message}
            </p>
            <p className="text-[10px] text-[var(--color-muted)]">
              清单跟着更新源走：留空读官方 GitHub Release，也可以在上面「应用更新」里填自建目录。
            </p>
          </div>
        )}

        {catalog === null && (
          <p className="text-[var(--color-muted)]">正在读取更新源里的插件清单…</p>
        )}

        {catalog !== null && !catalog.error && entries.length === 0 && (
          <p className="text-[var(--color-muted)]">
            更新源里没有可安装的插件。发布方把包挂在更新源目录后这里就会出现。
          </p>
        )}

        {entries.length > 0 && (
          <ul className="space-y-2 border-t border-[var(--color-border)] pt-3">
            {entries.map((entry) => {
              const key = `${entry.id}@${entry.version}`;
              const versions = externalVersions.get(entry.id) ?? [];
              const installedVersion = versions.includes(entry.version) ? entry.version : undefined;
              const other = versions.find((version) => version !== entry.version);
              // 已经装了别的插件就不能再装这一个（宿主也只认一个）。同一个 id 的其他版本
              // 不在此列：那是更新或回退，且旧版本留着才跑得动 pin 在旧版本上的战役
              const blocked = !installedVersion && other === undefined && hasExternal;
              const newer =
                other !== undefined && compareExactSemVer(entry.version, other) > 0;
              const label = installedVersion
                ? '已安装'
                : newer
                  ? `更新到 ${entry.version}`
                  : `安装 ${entry.version}`;
              return (
                <li key={key} className="flex items-start gap-3">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[var(--color-fg)]">{entry.displayName}</span>
                      {entry.type !== null && (
                        <Badge tone="bg-[var(--color-bg)] text-[var(--color-muted)]">
                          {TYPE_LABEL[entry.type]}
                        </Badge>
                      )}
                      {installedVersion === undefined && other !== undefined && (
                        <Badge tone="bg-emerald-500/10 text-emerald-400">{`已装 ${other}`}</Badge>
                      )}
                      {entry.releaseTag !== null && (
                        <span className="text-[10px] text-[var(--color-muted)]">
                          来自 {entry.releaseTag}
                        </span>
                      )}
                    </div>
                    {entry.described ? (
                      <>
                        {entry.description !== '' && (
                          <p className="text-[var(--color-muted)]">{entry.description}</p>
                        )}
                        {entry.permissions.length > 0 && (
                          <p className="text-[var(--color-muted)]">
                            需要权限：{permissionSummary(entry.permissions)}
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="text-[var(--color-muted)]">没读到这个包的说明，装完才看得到。</p>
                    )}
                  </div>
                  <button
                    type="button"
                    disabled={busy || blocked || installedVersion !== undefined}
                    onClick={() => void installFromCatalog(entry)}
                    className="shrink-0 rounded border border-[var(--color-border)] px-3 py-1.5 disabled:opacity-40 hover:text-[var(--color-fg)]"
                  >
                    {pendingKey === key ? '安装中…' : blocked ? '先卸载已装的' : label}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
