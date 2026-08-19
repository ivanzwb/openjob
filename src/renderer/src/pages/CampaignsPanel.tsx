import { useState } from 'react';
import { TabPanel } from '../components/TabPanel';
import { CampaignCreate } from './CampaignCreate';
import { CampaignDetail } from './CampaignDetail';
import { CampaignList } from './CampaignList';

export type CampaignView =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'detail'; id: string; autoDiagnose?: boolean; focusNodeId?: string; focusKey?: number };

function viewKey(view: CampaignView): string {
  return view.kind === 'detail' ? `detail:${view.id}` : view.kind;
}

export function CampaignsPanel({
  active,
  view,
  setView,
}: {
  active: boolean;
  view: CampaignView;
  setView: (view: CampaignView) => void;
}): React.JSX.Element {
  const [mounted, setMounted] = useState<Set<string>>(() => new Set(['list']));

  // 记录已挂载视图（keep-alive）：渲染期同步加入，避免 effect 内同步 setState
  const mountedKey = viewKey(view);
  if (!mounted.has(mountedKey)) {
    setMounted((prev) => new Set(prev).add(mountedKey));
  }

  const detailIds = [...mounted]
    .filter((key) => key.startsWith('detail:'))
    .map((key) => key.slice('detail:'.length));

  return (
    <TabPanel active={active} className="overflow-hidden">
      {mounted.has('list') && (
        <TabPanel active={view.kind === 'list'} className="overflow-y-auto">
          <CampaignList
            onOpen={(id) => setView({ kind: 'detail', id })}
            onCreate={() => setView({ kind: 'create' })}
          />
        </TabPanel>
      )}
      {mounted.has('create') && (
        <TabPanel active={view.kind === 'create'} className="overflow-y-auto">
          <CampaignCreate
            onCreated={(id) => setView({ kind: 'detail', id, autoDiagnose: true })}
            onCancel={() => setView({ kind: 'list' })}
          />
        </TabPanel>
      )}
      {detailIds.map((id) => (
        <TabPanel key={id} active={view.kind === 'detail' && view.id === id}>
          <CampaignDetail
            id={id}
            autoDiagnose={
              view.kind === 'detail' && view.id === id ? view.autoDiagnose : undefined
            }
            initialNodeId={view.kind === 'detail' && view.id === id ? view.focusNodeId : undefined}
            initialNodeKey={view.kind === 'detail' && view.id === id ? view.focusKey : undefined}
            onBack={() => setView({ kind: 'list' })}
          />
        </TabPanel>
      ))}
    </TabPanel>
  );
}
