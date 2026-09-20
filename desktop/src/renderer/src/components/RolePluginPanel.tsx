import { useCallback, useEffect, useRef, useState } from 'react';
import type { CampaignRuntimeView } from '@core/ipc';
import type { ClientCapabilityView, InstalledPlugin } from '@core/plugins/clientView';
import {
  INTERVIEW_LANGUAGE_OPTIONS,
  ROLE_LEVEL_OPTIONS,
  draftFromRuntime,
  isDraftDirty,
  listPluginOptions,
  pluginStatusNotice,
  toSetRoleProfileInput,
  type RoleProfileDraft,
} from '@core/hostUi';
import { invoke, onEvent } from '../ipc';
import { useDataRefresh } from '../ipc/dataVersion';
import { runTask, useTask, useTaskResult } from '../ipc/taskStore';

const SELECT_CLASS =
  'w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm';

/**
 * 自动落库的防抖窗口：连续改动只在停下来之后写一次。
 *
 * 每次选择都立刻反映在同一份草稿上，落库则合并成一次解析——下拉框连点几下不会各发
 * 一次 setRoleProfile，也就不会出现 A 的解析结果盖掉 B 的选择。
 */
const AUTOSAVE_DELAY_MS = 400;

/** 两份草稿是否等价；能力只看集合，不看顺序（勾选顺序不改变语义）。 */
function sameDraft(left: RoleProfileDraft, right: RoleProfileDraft): boolean {
  const sameIds = (a: readonly string[], b: readonly string[]): boolean => {
    if (a.length !== b.length) return false;
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    return sortedA.every((id, index) => id === sortedB[index]);
  };
  return (
    left.rolePackId === right.rolePackId &&
    left.level === right.level &&
    left.industryVariantId === right.industryVariantId &&
    left.location === right.location &&
    left.interviewLanguage === right.interviewLanguage &&
    sameIds(left.capabilityIds, right.capabilityIds)
  );
}

/**
 * 同一份解析结果的指纹。
 *
 * revision 之外还带上 configSnapshotHash：插件升级后 revision 不变而解析结果变了，
 * 只看 revision 会让表单继续显示上一套配置。installedCount 参与是因为岗位包清单决定了
 * 「没有 descriptor 时选哪个包」这个初值。
 */
function runtimeKey(
  campaignId: string,
  runtime: CampaignRuntimeView | null,
  installedCount: number,
): string {
  return [
    campaignId,
    installedCount,
    runtime?.revision ?? -1,
    runtime?.descriptor.configSnapshotHash ?? '',
  ].join('|');
}

/**
 * 岗位与行业包的选择界面。
 *
 * 这里是用户唯一能把「我要按什么岗位准备」写进系统的地方，也是 descriptor 唯一的人工
 * 入口。界面自己不认识任何一个岗位：选项来自本机安装清单，当前值来自 descriptor。
 * 每一次改动都自动落库——用户挑的那一刻就是生效的那一刻，没有单独的「确认」步骤，
 * 也就没有「尚未确认」这个中间态。整条链路上没有一处从 roleTitle 之类的岗位标题文本
 * 推断该显示什么：推断一旦出现，界面和 resolver 就会各持一套配置。
 *
 * 落库走 runTask 按 key 去重，同一轮解析没回来时不重入；期间用户若又改了，结果一回来就按
 * 最新草稿再写一次，保证最后一次选择一定生效。写入结果不回显成回执：面板显示的就是
 * descriptor 本身，resolver 给出的那一份解析结果会直接反映在下拉框与 descriptor 上。
 */
export function RolePluginPanel({ campaignId }: { campaignId: string }): React.JSX.Element {
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [runtime, setRuntime] = useState<CampaignRuntimeView | null>(null);
  const [clientView, setClientView] = useState<ClientCapabilityView | null>(null);
  // 存「这份数据属于哪场备考」而不是一个 loaded 布尔：换 Campaign 时旧数据自动不算数，
  // 不必在 effect 里先同步置一次 false
  const [loadedFor, setLoadedFor] = useState('');
  const [draft, setDraft] = useState<RoleProfileDraft | null>(null);
  const [syncKey, setSyncKey] = useState('');
  // 最近一次写出去的草稿；descriptor 换版回来时用它判断用户在解析途中是否又改过。用 state
  // 而不是 ref，是因为重建表单的判断发生在渲染期，渲染期不许读 ref。
  const [sentDraft, setSentDraft] = useState<RoleProfileDraft | null>(null);
  // 用户是否动过这个面板：没动过就不落库，避免「仅打开面板」把默认岗位包写进去
  const [touched, setTouched] = useState(false);
  // 表单初值是按哪场备考建的，用来把「换战役」和「同一场解析结果更新」分开处理
  const [syncedCampaign, setSyncedCampaign] = useState('');

  const saveKey = `campaign:${campaignId}:setRoleProfile`;
  const saveTask = useTask(saveKey);

  const refresh = useCallback(() => {
    void (async () => {
      const [plugins, view] = await Promise.all([
        invoke('plugin:listInstalled', undefined),
        invoke('campaign:getRuntimeDescriptor', { campaignId }),
      ]);
      // 本机能力视图是纯投影，没有 descriptor 时它本来就无从算起
      const client = view
        ? await invoke('campaign:getClientCapabilityView', { campaignId, platform: 'desktop' })
        : null;
      setInstalled(plugins);
      setRuntime(view);
      setClientView(client);
      setLoadedFor(campaignId);
    })().catch(() => setLoadedFor(campaignId));
  }, [campaignId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 装 / 卸插件后本机安装清单会变：主进程广播一次，这里就地重拉 installed 与本战役的
  // 解析视图，而不是等用户离开这一页再回来才看到新的岗位包。复用 refresh 不另写取数。
  useEffect(() => onEvent('plugin:inventory-changed', () => refresh()), [refresh]);

  useDataRefresh(refresh);

  const rolePackOptions = listPluginOptions(installed, 'role-pack');

  const loaded = loadedFor === campaignId;
  const currentKey = runtimeKey(campaignId, runtime, installed.length);

  // 载入、descriptor 换版或换战役时按事实源重建表单：descriptor 是唯一事实源，界面上的
  // 旧值没有保留价值。但用户在解析途中又改过（草稿与最近写出去的那份不同）就先留着，
  // 等这轮回执结束后按最新草稿再写一次，别让保存结果盖掉还没写出去的改动。
  if (loaded && syncedCampaign !== campaignId) {
    // 换战役：上一场遗留的草稿与判定依据一并作废
    setSyncedCampaign(campaignId);
    setSentDraft(null);
    setTouched(false);
    setSyncKey(currentKey);
    setDraft(draftFromRuntime(runtime, rolePackOptions));
  } else if (loaded && syncKey !== currentKey) {
    setSyncKey(currentKey);
    if (!sentDraft || draft === null || sameDraft(draft, sentDraft)) {
      setDraft(draftFromRuntime(runtime, rolePackOptions));
    }
  }

  useTaskResult<CampaignRuntimeView>(saveKey, (next) => {
    setRuntime(next);
    void invoke('campaign:getClientCapabilityView', { campaignId, platform: 'desktop' }).then(
      setClientView,
    );
  });

  // 选择即生效：把草稿防抖后写出去。runTask 按 key 去重，一轮没回来时不重入；等 running
  // 翻回 false 再按最新草稿补一次，于是连续改动最终一定落到库上，且不会两轮解析互相覆盖。
  // 用户没动过、又没有可比对的配置时不动手：否则仅打开面板就会把默认岗位包写进去。
  useEffect(() => {
    if (!loaded || !draft) return;
    if (!touched && !runtime) return;
    if (!draft.rolePackId) return;
    if (saveTask.running) return;
    if (!isDraftDirty(draft, runtime)) return;
    const timer = setTimeout(() => {
      setSentDraft(draft);
      void runTask(saveKey, () =>
        invoke('campaign:setRoleProfile', toSetRoleProfileInput(campaignId, draft)),
      ).catch(() => undefined);
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft, runtime, touched, loaded, saveTask.running, saveKey, campaignId]);

  // 还没落库的最新草稿：切走这一页（组件卸载）或换战役时把它补上，
  // 否则用户在防抖窗口内离开就会丢掉刚做的选择。
  const pending = useRef<RoleProfileDraft | null>(null);
  useEffect(() => {
    pending.current =
      loaded &&
      draft !== null &&
      draft.rolePackId.length > 0 &&
      (touched || runtime !== null) &&
      isDraftDirty(draft, runtime)
        ? draft
        : null;
  });

  useEffect(
    () => () => {
      const next = pending.current;
      if (!next) return;
      // 同一 key 已有写入在跑时 runTask 会复用，不会重复发
      void runTask(saveKey, () =>
        invoke('campaign:setRoleProfile', toSetRoleProfileInput(campaignId, next)),
      ).catch(() => undefined);
    },
    [saveKey, campaignId],
  );

  if (!loaded || !draft) {
    return <p className="text-sm text-[var(--color-muted)]">加载中…</p>;
  }

  const patch = (next: Partial<RoleProfileDraft>): void => {
    setTouched(true);
    setDraft((prev) => (prev ? { ...prev, ...next } : prev));
  };

  const rolePackNotice = pluginStatusNotice(clientView?.rolePack ?? null);

  // 行业差异是岗位包内的可选字段（非插件）：选项来自当前选中的岗位包，包没声明就没有这项
  const industryVariantOptions =
    rolePackOptions.find((option) => option.id === draft.rolePackId)?.industryVariants ?? [];

  return (
    <section className="space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">岗位与行业包</h3>
          <p className="mt-0.5 text-xs text-[var(--color-muted)]">
            出题、评分和考点都按这里选定的岗位包执行；改动会自动解析依赖并生效
          </p>
        </div>
        {clientView?.degraded && (
          <span className="rounded bg-amber-900/40 px-2 py-0.5 text-[10px] text-amber-200">
            本机能力低于配置
          </span>
        )}
      </div>

      {!runtime && (
        <p className="rounded border border-amber-900/50 bg-amber-950/20 px-3 py-2 text-xs text-amber-100">
          这场备考还没有解析出运行配置。选好岗位包就会自动解析依赖并激活配置。
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-xs text-[var(--color-muted)]">岗位包</span>
          <select
            value={draft.rolePackId}
            onChange={(e) => patch({ rolePackId: e.target.value })}
            className={SELECT_CLASS}
          >
            {rolePackOptions.length === 0 ? (
              <option value="">本机没有安装岗位包</option>
            ) : (
              rolePackOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.displayName} v{option.version}
                </option>
              ))
            )}
          </select>
          {rolePackNotice && <p className="text-[10px] text-amber-300">{rolePackNotice}</p>}
        </label>

        <label className="space-y-1">
          <span className="text-xs text-[var(--color-muted)]">级别</span>
          <select
            value={draft.level}
            onChange={(e) => patch({ level: e.target.value })}
            className={SELECT_CLASS}
          >
            <option value="">不指定</option>
            {ROLE_LEVEL_OPTIONS.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </label>

        {industryVariantOptions.length > 0 && (
          <label className="space-y-1">
            <span className="text-xs text-[var(--color-muted)]">行业</span>
            <select
              value={draft.industryVariantId}
              onChange={(e) => patch({ industryVariantId: e.target.value })}
              className={SELECT_CLASS}
            >
              <option value="">不指定</option>
              {industryVariantOptions.map((variant) => (
                <option key={variant.id} value={variant.id}>
                  {variant.displayName}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="space-y-1">
          <span className="text-xs text-[var(--color-muted)]">面试语言</span>
          <select
            value={draft.interviewLanguage}
            onChange={(e) => patch({ interviewLanguage: e.target.value })}
            className={SELECT_CLASS}
          >
            {INTERVIEW_LANGUAGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 sm:col-span-2">
          <span className="text-xs text-[var(--color-muted)]">城市</span>
          <input
            value={draft.location}
            onChange={(e) => patch({ location: e.target.value })}
            placeholder="影响薪资与市场类问题，可留空"
            className={SELECT_CLASS}
          />
        </label>
      </div>

      {saveTask.error && <p className="text-sm text-red-400">{saveTask.error}</p>}
    </section>
  );
}
