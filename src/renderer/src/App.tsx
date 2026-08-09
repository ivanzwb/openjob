import { useEffect, useState } from 'react';
import { StreamChat } from './components/StreamChat';
import { CampaignCreate } from './pages/CampaignCreate';
import { CampaignDetail } from './pages/CampaignDetail';
import { CampaignList } from './pages/CampaignList';
import { Settings } from './pages/Settings';
import { Overview } from './pages/Overview';
import { Repos } from './pages/Repos';
import { Scripts } from './pages/Scripts';
import { DesignPractice } from './pages/DesignPractice';
import { Today } from './pages/Today';
import { invoke } from './ipc';

type Tab = 'today' | 'overview' | 'campaigns' | 'design' | 'repos' | 'scripts' | 'chat' | 'settings';
type View = { kind: 'list' } | { kind: 'create' } | { kind: 'detail'; id: string; autoDiagnose?: boolean };

export default function App(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('today');
  const [view, setView] = useState<View>({ kind: 'list' });
  const [version, setVersion] = useState('');

  useEffect(() => {
    void invoke('app:getVersion', undefined).then(setVersion);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-4 border-b border-[var(--color-border)] px-5 py-3">
        <span className="font-semibold">openJob</span>
        <span className="text-xs text-[var(--color-muted)]">v{version}</span>
        <nav className="ml-4 flex gap-1">
          {(
            [
              ['today', '今日'],
              ['overview', '总览'],
              ['campaigns', '备考'],
              ['design', '设计'],
              ['repos', '源码'],
              ['scripts', '话术'],
              ['chat', '对话'],
              ['settings', '设置'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                setTab(key);
                if (key === 'campaigns') setView({ kind: 'list' });
              }}
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
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'today' && <Today />}
        {tab === 'overview' && (
          <Overview
            onOpenCampaign={(id) => {
              setTab('campaigns');
              setView({ kind: 'detail', id });
            }}
          />
        )}
        {tab === 'repos' && <Repos />}
        {tab === 'design' && <DesignPractice />}
        {tab === 'scripts' && <Scripts />}
        {tab === 'settings' && <Settings />}
        {tab === 'chat' && (
          <div className="mx-auto h-full w-full max-w-[1600px] p-6">
            <StreamChat role="explain" placeholder="试试问一个需要联网才能答准的问题…" />
          </div>
        )}
        {tab === 'campaigns' && view.kind === 'list' && (
          <CampaignList
            onOpen={(id) => setView({ kind: 'detail', id })}
            onCreate={() => setView({ kind: 'create' })}
          />
        )}
        {tab === 'campaigns' && view.kind === 'create' && (
          <CampaignCreate
            onCreated={(id) => setView({ kind: 'detail', id, autoDiagnose: true })}
            onCancel={() => setView({ kind: 'list' })}
          />
        )}
        {tab === 'campaigns' && view.kind === 'detail' && (
          <CampaignDetail
            id={view.id}
            autoDiagnose={view.autoDiagnose}
            onBack={() => setView({ kind: 'list' })}
          />
        )}
      </main>
    </div>
  );
}
