import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { CampaignSummary, KnowledgeNodeView, PlanGenerateResult, TaskView } from '@shared/ipc';
import { nodeIdsForPlanFilter } from '@shared/planFilter';
import { KeepAlivePanel } from '../components/KeepAlivePanel';
import { NodeFollowUpPanel } from '../components/NodeFollowUpPanel';
import { NodeStudyPanel } from '../components/NodeStudyPanel';
import { StudyPlanCalendarPopover } from '../components/StudyPlanCalendarPopover';
import { getRawDb } from '../db';
import { getCampaignDetail, getTodayPlan, listCampaigns } from '../data/queries';
import { createCampaign } from '../data/mutations';
import { invokeRemote } from '../remote/rpc';
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
  const [selectedNode, setSelectedNode] = useState<KnowledgeNodeView | null>(null);
  const [nodeStudyMode, setNodeStudyMode] = useState<'explain' | 'drill' | 'followUp'>('explain');
  const [interviewDate, setInterviewDate] = useState(detail.campaign.interviewDate ?? '');
  const [dailyMinutes, setDailyMinutes] = useState(String(detail.campaign.dailyMinutes ?? 90));
  const [planMsg, setPlanMsg] = useState<string | null>(null);
  const [calendarFilterDate, setCalendarFilterDate] = useState<string | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  const reload = () => {
    const next = getCampaignDetail(getRawDb(), id);
    setDetail(next);
    setInterviewDate(next.campaign.interviewDate ?? '');
    setDailyMinutes(String(next.campaign.dailyMinutes ?? 90));
  };

  const filterPlan = calendarFilterDate ? getTodayPlan(getRawDb(), id, calendarFilterDate) : null;
  const visibleNodeIds = useMemo(() => {
    if (!calendarFilterDate || !filterPlan) return null;
    return nodeIdsForPlanFilter(detail.nodes, filterPlan.tasks);
  }, [calendarFilterDate, filterPlan, detail.nodes, reloadTick]);
  const visibleNodes = useMemo(() => {
    if (!visibleNodeIds || visibleNodeIds.size === 0) {
      return calendarFilterDate ? [] : detail.nodes;
    }
    return detail.nodes.filter((n) => visibleNodeIds.has(n.id));
  }, [calendarFilterDate, detail.nodes, visibleNodeIds, reloadTick]);

  const openTaskInStudy = (task: TaskView): void => {
    if (!task.nodeId) return;
    const node = detail.nodes.find((n) => n.id === task.nodeId);
    if (!node) return;
    setSelectedNode(node);
    setNodeStudyMode(task.kind === 'drill' ? 'drill' : 'explain');
  };

  const diagnose = async () => {
    try {
      await runTask('JD 诊断', async () => {
        await invokeRemote('diagnosis:fromJd', { campaignId: id });
      });
      await triggerSync();
      reload();
      setStatusMsg('JD 诊断完成');
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const fetchIntel = async () => {
    try {
      await runTask('公司情报', async () => {
        await invokeRemote('diagnosis:fetchIntel', { campaignId: id });
      });
      await triggerSync();
      reload();
      setStatusMsg('公司情报已生成');
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const generatePlan = async () => {
    try {
      const res = await runTask('生成计划', async () => {
        const { result } = await invokeRemote<
          'plan:generate',
          { campaignId: string; interviewDate?: string; dailyMinutes?: number },
          PlanGenerateResult
        >('plan:generate', {
          campaignId: id,
          interviewDate: interviewDate || undefined,
          dailyMinutes: Number(dailyMinutes) || 90,
        });
        return result;
      });
      await triggerSync();
      reload();
      setPlanMsg(`已生成 ${res.daysCreated} 天计划、${res.tasksCreated} 个任务`);
      setReloadTick((t) => t + 1);
    } catch (e) {
      setPlanMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const busy = Boolean(active);

  return (
    <>
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: 16, gap: 10 }}>
      <Pressable onPress={onBack}>
        <Text style={{ color: theme.accent }}>← 返回列表</Text>
      </Pressable>
      <Text style={{ color: theme.text, fontSize: 18, fontWeight: '600' }}>
        {detail.campaign.company} · {detail.campaign.roleTitle}
      </Text>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Pressable
          onPress={() => void diagnose()}
          disabled={busy}
          style={{ backgroundColor: theme.accent, padding: 10, borderRadius: 8, opacity: busy ? 0.6 : 1 }}
        >
          <Text style={{ color: '#fff', fontSize: 12 }}>{active?.label === 'JD 诊断' ? '诊断中…' : 'JD 诊断'}</Text>
        </Pressable>
        <Pressable
          onPress={() => void fetchIntel()}
          disabled={busy}
          style={{ borderWidth: 1, borderColor: theme.border, padding: 10, borderRadius: 8, opacity: busy ? 0.6 : 1 }}
        >
          <Text style={{ color: theme.text, fontSize: 12 }}>{active?.label === '公司情报' ? '生成中…' : '公司情报'}</Text>
        </Pressable>
      </View>
      {statusMsg && <Text style={{ color: theme.muted, fontSize: 12 }}>{statusMsg}</Text>}

      <Text style={{ color: theme.muted, fontSize: 12 }}>点击考点学习；日历可筛选当日排期</Text>

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', flex: 1, gap: 4 }}>
          <Text style={{ color: theme.text, fontWeight: '600' }}>考点清单</Text>
          {calendarFilterDate && (
            <Pressable onPress={() => setCalendarFilterDate(null)}>
              <Text style={{ color: theme.accent, fontSize: 12 }}>· {calendarFilterDate.slice(5)} ×</Text>
            </Pressable>
          )}
        </View>
        <Pressable onPress={() => setCalendarOpen(true)}>
          <Text
            style={{
              color: calendarFilterDate ? theme.accent : theme.muted,
              fontSize: 12,
              fontWeight: calendarFilterDate ? '600' : '400',
            }}
          >
            日历{calendarFilterDate ? ` · ${calendarFilterDate.slice(5)}` : ''}
          </Text>
        </Pressable>
      </View>
      {visibleNodes.length === 0 ? (
        <Text style={{ color: theme.muted, fontSize: 12 }}>
          {calendarFilterDate ? '该日无排期考点' : '暂无考点'}
        </Text>
      ) : (
        visibleNodes.map((n) => (
          <Pressable
            key={n.id}
            onPress={() => {
              setSelectedNode(n);
              setNodeStudyMode('explain');
            }}
            style={{
              borderWidth: 1,
              borderColor: selectedNode?.id === n.id ? theme.accent : theme.border,
              borderRadius: 8,
              padding: 10,
              backgroundColor: theme.surface,
            }}
          >
            <Text style={{ color: theme.text }}>{n.name}</Text>
            <Text style={{ color: theme.muted, fontSize: 11 }}>
              {n.kind} · {n.coverageType} · 掌握 {n.mastery.toFixed(1)}
            </Text>
          </Pressable>
        ))
      )}
      {selectedNode && (
        <View style={sectionStyle}>
          <Text style={{ color: theme.text, fontWeight: '600', marginBottom: 8 }}>{selectedNode.name}</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
            <Pressable
              onPress={() => setNodeStudyMode('explain')}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 8,
                backgroundColor: nodeStudyMode === 'explain' ? theme.accent : theme.bg,
              }}
            >
              <Text style={{ color: nodeStudyMode === 'explain' ? '#fff' : theme.muted, fontSize: 12 }}>讲解</Text>
            </Pressable>
            <Pressable
              onPress={() => setNodeStudyMode('drill')}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 8,
                backgroundColor: nodeStudyMode === 'drill' ? theme.accent : theme.bg,
              }}
            >
              <Text style={{ color: nodeStudyMode === 'drill' ? '#fff' : theme.muted, fontSize: 12 }}>考我</Text>
            </Pressable>
            <Pressable
              onPress={() => setNodeStudyMode('followUp')}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 8,
                backgroundColor: nodeStudyMode === 'followUp' ? theme.accent : theme.bg,
              }}
            >
              <Text style={{ color: nodeStudyMode === 'followUp' ? '#fff' : theme.muted, fontSize: 12 }}>追问</Text>
            </Pressable>
          </View>
          {nodeStudyMode === 'followUp' ? (
            <NodeFollowUpPanel
              key={selectedNode.id}
              campaignId={id}
              nodeId={selectedNode.id}
              nodeName={selectedNode.name}
            />
          ) : (
            <NodeStudyPanel
              key={`${selectedNode.id}-${nodeStudyMode}`}
              nodeId={selectedNode.id}
              nodeName={selectedNode.name}
              mode={nodeStudyMode}
            />
          )}
        </View>
      )}
    </ScrollView>
    <StudyPlanCalendarPopover
      open={calendarOpen}
      onClose={() => setCalendarOpen(false)}
      campaignId={id}
      nodeCount={detail.nodes.length}
      interviewDate={interviewDate}
      dailyMinutes={dailyMinutes}
      onInterviewDateChange={setInterviewDate}
      onDailyMinutesChange={setDailyMinutes}
      planMsg={planMsg}
      onGeneratePlan={generatePlan}
      filterDate={calendarFilterDate}
      onFilterDateChange={setCalendarFilterDate}
      onOpenTask={openTaskInStudy}
      onTasksChanged={async () => {
        await triggerSync();
        reload();
        setReloadTick((t) => t + 1);
      }}
      busy={busy}
    />
    </>
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
const sectionStyle = { borderWidth: 1, borderColor: theme.border, borderRadius: 8, padding: 12, backgroundColor: theme.surface, gap: 8 };
