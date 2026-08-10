import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { CampaignSummary } from '@shared/ipc';
import { KeepAlivePanel } from '../components/KeepAlivePanel';
import { getRawDb } from '../db';
import { getCampaignDetail, listCampaigns } from '../data/queries';
import { createCampaign } from '../data/mutations';
import { invokeRemote, jobMessageFromEvents } from '../remote/rpc';
import { useApp } from '../context/AppContext';
import { useRemoteTask } from '../context/RemoteTaskContext';
import { theme } from '../theme';

function CampaignListView({
  onOpenDetail,
}: {
  onOpenDetail: (id: string) => void;
}): React.JSX.Element {
  const { triggerSync } = useApp();
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [company, setCompany] = useState('');
  const [role, setRole] = useState('');
  const [jd, setJd] = useState('');

  const reload = () => setCampaigns(listCampaigns(getRawDb()));

  useEffect(() => {
    reload();
  }, []);

  const create = async () => {
    const id = await createCampaign(getRawDb(), company, role, jd);
    setCompany('');
    setRole('');
    setJd('');
    reload();
    await triggerSync();
    onOpenDetail(id);
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: 16, gap: 10 }}>
      <Text style={{ color: theme.text, fontSize: 20, fontWeight: '600' }}>备考</Text>
      <TextInput placeholder="公司" placeholderTextColor={theme.muted} value={company} onChangeText={setCompany} style={inputStyle} />
      <TextInput placeholder="岗位" placeholderTextColor={theme.muted} value={role} onChangeText={setRole} style={inputStyle} />
      <TextInput placeholder="JD" placeholderTextColor={theme.muted} value={jd} onChangeText={setJd} multiline style={[inputStyle, { minHeight: 80 }]} />
      <Pressable onPress={() => void create()} style={btnStyle}>
        <Text style={{ color: '#fff' }}>创建</Text>
      </Pressable>
      {campaigns.map((c) => (
        <Pressable key={c.id} onPress={() => onOpenDetail(c.id)} style={cardStyle}>
          <Text style={{ color: theme.text }}>{c.company} · {c.roleTitle}</Text>
          <Text style={{ color: theme.muted, fontSize: 11 }}>{c.nodeCount} 考点 · {c.status}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function CampaignDetailView({
  id,
  onBack,
}: {
  id: string;
  onBack: () => void;
}): React.JSX.Element {
  const { triggerSync } = useApp();
  const { runTask, active } = useRemoteTask();
  const [detail, setDetail] = useState(() => getCampaignDetail(getRawDb(), id));
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const reload = () => setDetail(getCampaignDetail(getRawDb(), id));

  const diagnose = async () => {
    try {
      const msg = await runTask('JD 诊断', async () => {
        const { events } = await invokeRemote('diagnosis:fromJd', { campaignId: id });
        return jobMessageFromEvents(events);
      });
      await triggerSync();
      reload();
      setStatusMsg(msg);
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const busy = active?.label === 'JD 诊断';

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: 16, gap: 8 }}>
      <Pressable onPress={onBack}>
        <Text style={{ color: theme.accent }}>← 返回列表</Text>
      </Pressable>
      <Text style={{ color: theme.text, fontSize: 18, fontWeight: '600' }}>
        {detail.campaign.company} · {detail.campaign.roleTitle}
      </Text>
      <Pressable
        onPress={() => void diagnose()}
        disabled={busy}
        style={{ backgroundColor: theme.accent, padding: 10, borderRadius: 8, alignItems: 'center', opacity: busy ? 0.6 : 1 }}
      >
        <Text style={{ color: '#fff' }}>{busy ? '诊断中…' : 'JD 诊断（桌面代理）'}</Text>
      </Pressable>
      {statusMsg && <Text style={{ color: theme.muted, fontSize: 12 }}>{statusMsg}</Text>}
      {detail.nodes.map((n) => (
        <View key={n.id} style={{ borderWidth: 1, borderColor: theme.border, borderRadius: 8, padding: 10, backgroundColor: theme.surface }}>
          <Text style={{ color: theme.text }}>{n.name}</Text>
          <Text style={{ color: theme.muted, fontSize: 11 }}>
            {n.kind} · {n.coverageType} · 掌握 {n.mastery.toFixed(1)}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

export function CampaignsScreen(): React.JSX.Element {
  const [detailId, setDetailId] = useState<string | null>(null);
  const [mountedDetails, setMountedDetails] = useState<Set<string>>(() => new Set());

  const openDetail = (id: string) => {
    setDetailId(id);
    setMountedDetails((prev) => new Set(prev).add(id));
  };

  return (
    <View style={{ flex: 1 }}>
      <KeepAlivePanel active={detailId === null}>
        <CampaignListView onOpenDetail={openDetail} />
      </KeepAlivePanel>
      {[...mountedDetails].map((id) => (
        <KeepAlivePanel key={id} active={detailId === id}>
          <CampaignDetailView id={id} onBack={() => setDetailId(null)} />
        </KeepAlivePanel>
      ))}
    </View>
  );
}

const inputStyle = { color: theme.text, borderWidth: 1, borderColor: theme.border, borderRadius: 8, padding: 10 };
const btnStyle = { backgroundColor: theme.accent, padding: 12, borderRadius: 8, alignItems: 'center' as const };
const cardStyle = { borderWidth: 1, borderColor: theme.border, borderRadius: 8, padding: 12, backgroundColor: theme.surface };
