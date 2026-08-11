import { useEffect, useState } from 'react';
import { ScrollView, Text } from 'react-native';
import type { CampaignOverview } from '@shared/ipc';
import { getRawDb } from '../db';
import { getCampaignOverview } from '../data/queries';
import { theme } from '../theme';

export function OverviewScreen(): React.JSX.Element {
  const [overview, setOverview] = useState<CampaignOverview | null>(null);

  useEffect(() => {
    setOverview(getCampaignOverview(getRawDb()));
  }, []);

  if (!overview) return <Text style={{ color: theme.muted, padding: 16 }}>加载中…</Text>;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ color: theme.muted }}>活跃备考 {overview.activeCampaignCount} / 共 {overview.campaignCount}</Text>
      <Text style={{ color: theme.muted }}>平均掌握度 {(overview.avgMastery * 20).toFixed(0)}%</Text>
      <Text style={{ color: theme.muted }}>盲区 {overview.totalBlindSpots}</Text>
    </ScrollView>
  );
}
