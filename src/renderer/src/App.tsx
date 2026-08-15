import { Component, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { TabPanel } from './components/TabPanel';
import { UpdateBadge } from './components/UpdateBadge';
import { CampaignsPanel, type CampaignView } from './pages/CampaignsPanel';
import { Settings } from './pages/Settings';
import { Overview } from './pages/Overview';
import { Repos } from './pages/Repos';
import { Scripts } from './pages/Scripts';
import { DesignPractice } from './pages/DesignPractice';
import { Resumes } from './pages/Resumes';
import { invoke, onEvent } from './ipc';
import { bumpDataVersion } from './ipc/dataVersion';
import { useJobProgress } from './ipc/useJobProgress';
import { reportBackgroundError, useBackgroundErrorToast } from './ipc/errorToast';

type Tab = 'overview' | 'campaigns' | 'resumes' | 'design' | 'repos' | 'scripts' | 'settings';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'overview', label: '总览' },
  { key: 'resumes', label: '简历' },
  { key: 'campaigns', label: '备考' },
  { key: 'design', label: '模拟面试' },
  { key: 'repos', label: '源码' },
  { key: 'scripts', label: '话术' },
  { key: 'settings', label: '设置' },
];

/** 渲染崩溃时展示错误文本而不是黑屏，便于定位（同时兜住用户数据界面） */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error('[render crash]', error);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <pre className="whitespace-pre-wrap p-6 text-sm text-red-400">
          {this.state.error.stack ?? String(this.state.error)}
        </pre>
      );
    }
    return this.props.children;
  }
}

export default function App(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('campaigns');
  const [mountedTabs, setMountedTabs] = useState<Set<Tab>>(() => new Set(['campaigns']));
  const [view, setView] = useState<CampaignView>({ kind: 'list' });
  const [version, setVersion] = useState('');
  const { active: job, lastResult: jobResult } = useJobProgress();
  // 任务与流式请求可能在用户已经切走的页面上失败，提示统一由这里弹出来
  useBackgroundErrorToast();

  // 诊断、情报这类长任务跑在主进程：失败若不提示，用户只看到按钮悄悄变回可点
  useEffect(() => {
    if (jobResult?.error) reportBackgroundError(`${jobResult.label}失败：${jobResult.error}`);
  }, [jobResult]);

  useEffect(() => {
    void invoke('app:getVersion', undefined).then(setVersion);
  }, []);

  // 手机端同步把变更落库后，数据页需要重拉：任何同步完成都全局 bump 数据版本
  useEffect(() => onEvent('sync:finished', () => bumpDataVersion()), []);

  const selectTab = (key: Tab): void => {
    setTab(key);
    setMountedTabs((prev) => new Set(prev).add(key));
  };

  return (
    <ErrorBoundary>
      <div className="flex h-full flex-col">
        <header className="flex shrink-0 items-center gap-4 border-b border-[var(--color-border)] px-5 py-3">
          <div className="flex items-center gap-2.5">
            <img src="./logo.png" alt="" className="h-7 w-7 rounded-lg" />
            <span className="font-semibold">OpenJob</span>
          </div>
          <span className="text-xs text-[var(--color-muted)]">v{version}</span>
          <UpdateBadge onOpenSettings={() => selectTab('settings')} />
          <nav className="ml-4 flex gap-1">
            {TABS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => selectTab(key)}
                className={`rounded px-3 py-1 text-sm ${
                  tab === key
                    ? 'bg-[var(--color-surface)] text-[var(--color-fg)]'
                    : 'text-[var(--color-muted)] hover:text-[var(--color-fg)]'
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
          {job && (
            <div className="ml-auto max-w-md truncate text-xs text-[var(--color-muted)]">
              <span className="text-[var(--color-fg)]">{job.label}</span>
              {job.message ? ` · ${job.message}` : null}
              {job.progress != null ? ` (${Math.round(job.progress * 100)}%)` : null}
            </div>
          )}
        </header>

        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {mountedTabs.has('overview') && (
            <TabPanel active={tab === 'overview'} className="overflow-y-auto">
              <Overview
                onOpenCampaign={(id) => {
                  setView({ kind: 'detail', id });
                  selectTab('campaigns');
                }}
              />
            </TabPanel>
          )}
          {mountedTabs.has('resumes') && (
            <TabPanel active={tab === 'resumes'} className="overflow-hidden">
              <Resumes />
            </TabPanel>
          )}
          {mountedTabs.has('campaigns') && (
            <CampaignsPanel active={tab === 'campaigns'} view={view} setView={setView} />
          )}
          {mountedTabs.has('design') && (
            <TabPanel active={tab === 'design'} className="overflow-y-auto">
              <DesignPractice />
            </TabPanel>
          )}
          {mountedTabs.has('repos') && (
            <TabPanel active={tab === 'repos'} className="overflow-hidden">
              <Repos />
            </TabPanel>
          )}
          {mountedTabs.has('scripts') && (
            <TabPanel active={tab === 'scripts'} className="overflow-hidden">
              <Scripts />
            </TabPanel>
          )}
          {mountedTabs.has('settings') && (
            <TabPanel active={tab === 'settings'} className="overflow-y-auto">
              <Settings />
            </TabPanel>
          )}
        </main>
      </div>
    </ErrorBoundary>
  );
}
