import { useCallback, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { CampaignOverview } from '@shared/ipc';
import { getRawDb } from '../db';
import { getCampaignOverview } from '../data/queries';
import { useLocalDataReload } from '../hooks/useLocalDataReload';
import type { RootTabParamList } from '../navigation/RootTabs';
import { useTheme, type Palette } from '../theme';

type OverviewProps = BottomTabScreenProps<RootTabParamList, 'Overview'>;

function statCard(theme: Palette, label: string, value: string, onPress: () => void): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      style={{
        flex: 1,
        minWidth: '45%',
        borderWidth: 1,
        borderColor: theme.border,
        borderRadius: 8,
        padding: 12,
        backgroundColor: theme.surface,
      }}
    >
      <Text style={{ color: theme.text, fontSize: 22, fontWeight: '600' }}>{value}</Text>
      <Text style={{ color: theme.muted, fontSize: 11, marginTop: 4 }}>{label}</Text>
    </Pressable>
  );
}

export function OverviewScreen({ navigation }: OverviewProps): React.JSX.Element {
  const theme = useTheme();
  const [overview, setOverview] = useState<CampaignOverview | null>(null);

  const reload = useCallback(() => {
    setOverview(getCampaignOverview(getRawDb()));
  }, []);

  useLocalDataReload(reload);

  if (!overview) {
    return <Text style={{ color: theme.muted, padding: 16 }}>加载总览…</Text>;
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ color: theme.muted, fontSize: 12 }}>
        跨 Campaign 累积的真题先验与薄弱点一览（数据来自本地同步库）
      </Text>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {statCard(theme, 'Campaign', String(overview.campaignCount), () => navigation.navigate('Campaigns'))}
        {statCard(theme, '进行中', String(overview.activeCampaignCount), () => navigation.navigate('Campaigns'))}
        {statCard(theme, '话术', String(overview.totalSpeechSnippets), () => navigation.navigate('Scripts'))}
        {statCard(theme, '盲区题', String(overview.totalBlindSpots), () => navigation.navigate('Campaigns'))}
      </View>

      <View style={{ borderWidth: 1, borderColor: theme.border, borderRadius: 8, padding: 12, backgroundColor: theme.surface }}>
        <Text style={{ color: theme.text, fontSize: 13, fontWeight: '600' }}>平均掌握度</Text>
        <Text style={{ color: theme.accent, fontSize: 28, fontWeight: '600', marginTop: 6 }}>
          {(overview.avgMastery * 20).toFixed(0)}%
        </Text>
      </View>

      {overview.weakNodes.length > 0 && (
        <View style={{ gap: 8 }}>
          <Text style={{ color: theme.text, fontSize: 13, fontWeight: '600' }}>薄弱考点</Text>
          {overview.weakNodes.map((n) => (
            <Pressable
              key={n.nodeId}
              onPress={() =>
                navigation.navigate('Campaigns', {
                  campaignId: n.campaignId,
                  nodeId: n.nodeId,
                  focusKey: Date.now(),
                })
              }
              style={{ borderWidth: 1, borderColor: theme.border, borderRadius: 8, padding: 10, backgroundColor: theme.surface }}
            >
              <Text style={{ color: theme.text, fontSize: 12 }}>{n.nodeName}</Text>
              <Text style={{ color: theme.muted, fontSize: 11 }}>
                {n.company} · {n.roleTitle} · 掌握 {(n.mastery * 20).toFixed(0)}%
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {overview.campaigns.length > 0 && (
        <View style={{ gap: 8 }}>
          <Text style={{ color: theme.text, fontSize: 13, fontWeight: '600' }}>备考战役</Text>
          {overview.campaigns.map((c) => (
            <Pressable
              key={c.id}
              onPress={() => navigation.navigate('Campaigns', { campaignId: c.id, focusKey: Date.now() })}
              style={{ borderWidth: 1, borderColor: theme.border, borderRadius: 8, padding: 10, backgroundColor: theme.surface }}
            >
              <Text style={{ color: theme.text, fontSize: 12 }}>{c.company} · {c.roleTitle}</Text>
              <Text style={{ color: theme.muted, fontSize: 11 }}>{c.nodeCount} 考点 · {c.status}</Text>
            </Pressable>
          ))}
        </View>
      )}

      {overview.campaigns.length === 0 && (
        <Text style={{ color: theme.muted, fontSize: 13 }}>暂无备考数据，请先在桌面端创建或完成同步</Text>
      )}
    </ScrollView>
  );
}
