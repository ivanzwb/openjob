import { useCallback, useEffect, useRef, useState } from 'react';
import type { CampaignRuntimeView } from '@core/ipc';
import type { ClientCapabilityView, InstalledPlugin } from '@core/plugins/clientView';
import {
  INTERVIEW_LANGUAGE_OPTIONS,
  ROLE_LEVEL_OPTIONS,
  buildCapabilityRows,
  draftFromRuntime,
  isDraftDirty,
  listPluginOptions,
  pluginStatusNotice,
  reconcileCapabilitySelection,
  reconciliationNotices,
  toSetRoleProfileInput,
  type RoleProfileDraft,
} from '@core/hostUi';
import { CapabilityStatusList } from './CapabilityStatusList';
import { invoke } from '../ipc';
import { useDataRefresh } from '../ipc/dataVersion';
import { runTask, useTask, useTaskResult } from '../ipc/taskStore';

const SELECT_CLASS =
  'w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm';

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

interface SaveFeedback {
  /** 这条回执描述的是哪一次解析结果；换了一版就不再显示 */
  key: string;
  notices: string[];
}

/**
 * 岗位与能力插件的确认界面。
 *
 * 这里是用户唯一能把「我要按什么岗位准备」写进系统的地方，也是 descriptor 唯一的人工
 * 入口。界面自己不认识任何一个岗位：选项来自本机安装清单，当前值来自 descriptor，
 * 提交之后再按返回的 descriptor 把表单校正回来。整条链路上没有一处从 roleTitle 之类的
 * 岗位标题文本推断该显示什么——推断一旦出现，界面和 resolver 就会各持一套配置。
 *
 * 「确认」不只是保存偏好：setRoleProfile 会重跑依赖解析并激活新的 binding revision，
 * 所以回执要把 resolver 实际给出的结果和用户勾的东西之间的差异说出来，而不是让复选框
 * 自己悄悄弹回去。
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
  const [feedback, setFeedback] = useState<SaveFeedback | null>(null);
  // 提交时用户勾了什么，要留到回执回来时才用得上；期间表单已经被 descriptor 校正过了
  const requested = useRef<string[]>([]);

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

  useDataRefresh(refresh);

  const rolePackOptions = listPluginOptions(installed, 'role-pack');
  const industryPackOptions = listPluginOptions(installed, 'industry-pack');
  const capabilityRows = buildCapabilityRows({
    descriptor: runtime?.descriptor ?? null,
    view: clientView,
    installed,
  });

  const displayName = (id: string): string =>
    installed.find((plugin) => plugin.id === id)?.displayName ?? id;

  const loaded = loadedFor === campaignId;
  // descriptor 换了一版就按新版重建表单：这是唯一事实源，界面上的旧值没有保留价值
  const currentKey = runtimeKey(campaignId, runtime, installed.length);
  if (loaded && syncKey !== currentKey) {
    setSyncKey(currentKey);
    setDraft(draftFromRuntime(runtime, rolePackOptions));
  }

  useTaskResult<CampaignRuntimeView>(saveKey, (next) => {
    setRuntime(next);
    setFeedback({
      key: runtimeKey(campaignId, next, installed.length),
      notices: reconciliationNotices(
        reconcileCapabilitySelection(requested.current, next.descriptor),
        displayName,
      ),
    });
    void invoke('campaign:getClientCapabilityView', { campaignId, platform: 'desktop' }).then(
      setClientView,
    );
  });

  if (!loaded || !draft) {
    return <p className="text-sm text-[var(--color-muted)]">加载中…</p>;
  }

  const patch = (next: Partial<RoleProfileDraft>): void => {
    setDraft((prev) => (prev ? { ...prev, ...next } : prev));
    setFeedback(null);
  };

  const toggleCapability = (id: string, checked: boolean): void => {
    patch({
      capabilityIds: checked
        ? [...draft.capabilityIds, id].filter((item, index, all) => all.indexOf(item) === index)
        : draft.capabilityIds.filter((item) => item !== id),
    });
  };

  const confirm = (): void => {
    if (!draft.rolePackId) return;
    requested.current = [...draft.capabilityIds];
    void runTask(saveKey, () =>
      invoke('campaign:setRoleProfile', toSetRoleProfileInput(campaignId, draft)),
    ).catch(() => undefined);
  };

  const profile = runtime?.roleProfile ?? null;
  const dirty = isDraftDirty(draft, runtime);
  const rolePackNotice = pluginStatusNotice(clientView?.rolePack ?? null);
  const industryPackNotice = pluginStatusNotice(clientView?.industryPack ?? null);
  const showFeedback = feedback?.key === currentKey ? feedback : null;

  return (
    <section className="space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">岗位与能力插件</h3>
          <p className="mt-0.5 text-xs text-[var(--color-muted)]">
            出题、评分和考点都按这里确认的岗位包执行；改完要点「确认」才会生效
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {profile?.userConfirmed ? (
            <span className="rounded bg-emerald-900/40 px-2 py-0.5 text-[10px] text-emerald-300">
              已确认
            </span>
          ) : runtime ? (
            <span className="rounded bg-amber-900/40 px-2 py-0.5 text-[10px] text-amber-200">
              自动识别，待确认
            </span>
          ) : (
            <span className="rounded bg-red-950/40 px-2 py-0.5 text-[10px] text-red-300">
              尚未确认岗位
            </span>
          )}
          {profile && !profile.userConfirmed && (
            <span className="text-[10px] text-[var(--color-muted)]">
              置信度 {Math.round(profile.confidence * 100)}%
            </span>
          )}
          {clientView?.degraded && (
            <span className="rounded bg-amber-900/40 px-2 py-0.5 text-[10px] text-amber-200">
              本机能力低于配置
            </span>
          )}
        </div>
      </div>

      {!runtime && (
        <p className="rounded border border-amber-900/50 bg-amber-950/20 px-3 py-2 text-xs text-amber-100">
          这场备考还没有解析出运行配置。选好岗位包后点「确认」，系统会解析依赖并激活配置。
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

        <label className="space-y-1">
          <span className="text-xs text-[var(--color-muted)]">行业包</span>
          <select
            value={draft.industryPackId}
            onChange={(e) => patch({ industryPackId: e.target.value })}
            className={SELECT_CLASS}
          >
            <option value="">不挂行业包</option>
            {industryPackOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.displayName} v{option.version}
              </option>
            ))}
          </select>
          {industryPackNotice && <p className="text-[10px] text-amber-300">{industryPackNotice}</p>}
        </label>

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

      <div className="space-y-2">
        <h4 className="text-xs font-medium text-[var(--color-muted)]">能力插件</h4>
        <CapabilityStatusList
          rows={capabilityRows}
          selectedIds={draft.capabilityIds}
          onToggle={toggleCapability}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={saveTask.running || !draft.rolePackId || !dirty}
          onClick={confirm}
          className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm text-white disabled:opacity-40"
        >
          {saveTask.running ? '解析中…' : '确认岗位'}
        </button>
        {!dirty && !saveTask.running && (
          <span className="text-xs text-[var(--color-muted)]">与当前生效配置一致</span>
        )}
      </div>

      {saveTask.error && <p className="text-sm text-red-400">{saveTask.error}</p>}

      {showFeedback && (
        <div className="space-y-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
          <p className="text-xs text-emerald-400">
            已确认，配置版本 v{runtime?.revision}
            {showFeedback.notices.length > 0 ? '；以下几项与你的勾选不同：' : ''}
          </p>
          {showFeedback.notices.map((notice) => (
            <p key={notice} className="text-[10px] text-amber-300">
              {notice}
            </p>
          ))}
        </div>
      )}

      {runtime && (
        <p className="border-t border-[var(--color-border)] pt-3 text-[10px] text-[var(--color-muted)]">
          配置版本 v{runtime.revision} · 内核 {runtime.descriptor.coreVersion} · 能力基线{' '}
          {runtime.descriptor.competencyBaselineVersion} · 快照{' '}
          {runtime.descriptor.configSnapshotHash.slice(0, 12)} · 解析于{' '}
          {new Date(runtime.descriptor.resolvedAt).toLocaleString()}
        </p>
      )}
    </section>
  );
}
