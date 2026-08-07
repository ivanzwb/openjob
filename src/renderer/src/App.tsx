import { useEffect, useState } from 'react';
import { StreamChat } from './components/StreamChat';
import { Settings } from './pages/Settings';
import { invoke } from './ipc';

type Tab = 'chat' | 'settings';

export default function App(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('settings');
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
              ['settings', '设置'],
              ['chat', '对话'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
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
        {tab === 'settings' ? (
          <Settings />
        ) : (
          <div className="mx-auto h-full max-w-3xl p-6">
            <StreamChat role="explain" placeholder="试试问一个需要联网才能答准的问题…" />
          </div>
        )}
      </main>
    </div>
  );
}
