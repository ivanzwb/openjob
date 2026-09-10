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
import { useCapabilityNav } from './ipc/useCapabilityNav';
import { useBackgroundErrorToast } from './ipc/errorToast';
import { nextVisibleTab } from '@core/hostUi';
import { SOURCE_REPOSITORY_CAPABILITY_ID } from '@core/plugins/builtin/sourceRepository';

type Tab = 'overview' | 'campaigns' | 'resumes' | 'design' | 'repos' | 'scripts' | 'settings';

/** 页签被能力门控藏起来时的落脚点：备考是这个应用的主线，回到它总是说得通 */
const FALLBACK_TAB: Tab = 'campaigns';

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

function WindowControls(): React.JSX.Element {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    void invoke('window:getState', undefined).then(({ maximized: next }) => setMaximized(next));
    return onEvent('window:state', ({ maximized: next }) => setMaximized(next));
  }, []);

  const controlClass =
    'flex h-full w-11 items-center justify-center text-[var(--color-muted)] hover:bg-black/10 hover:text-[var(--color-fg)]';

  return (
    <div className="app-region-no-drag flex h-full items-stretch">
      <button
        type="button"
        className={controlClass}
        aria-label="最小化窗口"
        onClick={() => void invoke('window:minimize', undefined)}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true" className="h-3.5 w-3.5">
          <path d="M2 6.5h8v1H2z" fill="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        className={controlClass}
        aria-label={maximized ? '还原窗口' : '最大化窗口'}
        onClick={() => void invoke('window:toggleMaximize', undefined).then(({ maximized: next }) => setMaximized(next))}
      >
        {maximized ? (
          <svg viewBox="0 0 12 12" aria-hidden="true" className="h-3.5 w-3.5">
            <path d="M4 2h6v6H8V4H4z" fill="none" stroke="currentColor" strokeWidth="1.1" />
            <path d="M2 4h6v6H2z" fill="none" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        ) : (
          <svg viewBox="0 0 12 12" aria-hidden="true" className="h-3.5 w-3.5">
            <path d="M2.5 2.5h7v7h-7z" fill="none" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        )}
      </button>
      <button
        type="button"
        className={`${controlClass} hover:bg-red-500 hover:text-white`}
        aria-label="关闭窗口"
        onClick={() => void invoke('window:close', undefined)}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true" className="h-3.5 w-3.5">
          <path
            d="m3.2 2.5 6.3 6.3-.7.7-6.3-6.3zm6.3.7L3.2 9.5l-.7-.7 6.3-6.3z"
            fill="currentColor"
          />
        </svg>
      </button>
    </div>
  );
}

export default function App(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('campaigns');
  const [mountedTabs, setMountedTabs] = useState<Set<Tab>>(() => new Set(['campaigns']));
  const [view, setView] = useState<CampaignView>({ kind: 'list' });
  const [version, setVersion] = useState('');
  const { active: job } = useJobProgress();
  // 任务与流式请求可能在用户已经切走的页面上失败，提示统一由这里弹出来
  useBackgroundErrorToast();

  // 源码页是 source-repository 能力插件的宿主界面，没有任何 Campaign 启用它时不该出现
  const reposEnabled = useCapabilityNav(SOURCE_REPOSITORY_CAPABILITY_ID);
  const isTabVisible = (key: Tab): boolean => key !== 'repos' || reposEnabled;
  // 门控是异步算出来的，用户可能正停在被藏起来的页签上：渲染期同步换页，
  // 免得看到一个没有选中项的导航栏和一片空白
  const activeTab = nextVisibleTab(tab, isTabVisible, FALLBACK_TAB);
  if (activeTab !== tab) setTab(activeTab);

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
        <header className="app-region-drag flex h-12 shrink-0 items-center gap-4 border-b border-[var(--color-border)] pl-5">
          <div className="flex items-center gap-2.5">
            <img src="./logo.png" alt="" className="h-7 w-7 rounded-lg" />
            <span className="font-semibold">OpenJob</span>
          </div>
          <span className="text-xs text-[var(--color-muted)]">v{version}</span>
          <div className="app-region-no-drag">
            <UpdateBadge onOpenSettings={() => selectTab('settings')} />
          </div>
          <nav className="app-region-no-drag ml-4 flex gap-1">
            {TABS.filter(({ key }) => isTabVisible(key)).map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => selectTab(key)}
                className={`rounded px-3 py-1 text-sm ${
                  activeTab === key
                    ? 'bg-[var(--color-surface)] text-[var(--color-fg)]'
                    : 'text-[var(--color-muted)] hover:text-[var(--color-fg)]'
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex h-full min-w-0 items-center justify-end gap-3">
            {job && (
              <div className="min-w-0 max-w-md truncate text-xs text-[var(--color-muted)]">
                <span className="text-[var(--color-fg)]">{job.label}</span>
                {job.message ? ` · ${job.message}` : null}
                {job.progress != null ? ` (${Math.round(job.progress * 100)}%)` : null}
              </div>
            )}
            <WindowControls />
          </div>
        </header>

        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {mountedTabs.has('overview') && (
            <TabPanel active={activeTab === 'overview'} className="overflow-y-auto">
              <Overview
                onOpenCampaign={(id, nodeId) => {
                  setView({ kind: 'detail', id, focusNodeId: nodeId, focusKey: Date.now() });
                  selectTab('campaigns');
                }}
                onOpenCampaignsList={() => {
                  setView({ kind: 'list' });
                  selectTab('campaigns');
                }}
                onOpenScripts={() => selectTab('scripts')}
              />
            </TabPanel>
          )}
          {mountedTabs.has('resumes') && (
            <TabPanel active={activeTab === 'resumes'} className="overflow-hidden">
              <Resumes />
            </TabPanel>
          )}
          {mountedTabs.has('campaigns') && (
            <CampaignsPanel active={activeTab === 'campaigns'} view={view} setView={setView} />
          )}
          {mountedTabs.has('design') && (
            <TabPanel active={activeTab === 'design'} className="overflow-y-auto">
              <DesignPractice />
            </TabPanel>
          )}
          {/* 能力被关掉之后连挂载也撤掉：留着的话仓库索引仍在后台跑，用户却没有入口停它 */}
          {mountedTabs.has('repos') && isTabVisible('repos') && (
            <TabPanel active={activeTab === 'repos'} className="overflow-hidden">
              <Repos />
            </TabPanel>
          )}
          {mountedTabs.has('scripts') && (
            <TabPanel active={activeTab === 'scripts'} className="overflow-hidden">
              <Scripts />
            </TabPanel>
          )}
          {mountedTabs.has('settings') && (
            <TabPanel active={activeTab === 'settings'} className="overflow-y-auto">
              <Settings />
            </TabPanel>
          )}
        </main>
      </div>
    </ErrorBoundary>
  );
}
