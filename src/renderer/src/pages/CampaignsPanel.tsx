import { useEffect, useState } from 'react';
import { TabPanel } from '../components/TabPanel';
import { CampaignCreate } from './CampaignCreate';
import { CampaignDetail } from './CampaignDetail';
import { CampaignList } from './CampaignList';

export type CampaignView =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'detail'; id: string; autoDiagnose?: boolean };

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

  useEffect(() => {
    setMounted((prev) => new Set(prev).add(viewKey(view)));
  }, [view]);

  const detailIds = [...mounted]
    .filter((key) => key.startsWith('detail:'))
    .map((key) => key.slice('detail:'.length));

  return (
    <TabPanel active={active} className="overflow-y-auto">
      {mounted.has('list') && (
        <TabPanel active={view.kind === 'list'}>
          <CampaignList
            onOpen={(id) => setView({ kind: 'detail', id })}
            onCreate={() => setView({ kind: 'create' })}
          />
        </TabPanel>
      )}
      {mounted.has('create') && (
        <TabPanel active={view.kind === 'create'}>
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
            onBack={() => setView({ kind: 'list' })}
          />
        </TabPanel>
      ))}
    </TabPanel>
  );
}
