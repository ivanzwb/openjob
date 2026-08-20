import { useCallback, useMemo, useRef, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { CampaignSummary, KnowledgeNodeView, TaskView } from '@shared/ipc';
import type { NodeStatus } from '@shared/enums';
import { nodeIdsForPlanFilter, nodeIdsForTreeFilter } from '@shared/planFilter';
import { KeepAlivePanel } from '../components/KeepAlivePanel';
import { KnowledgeTree, type NodePatch } from '../components/KnowledgeTree';
import { NodeFollowUpPanel } from '../components/NodeFollowUpPanel';
import { NodeStudyPanel } from '../components/NodeStudyPanel';
import { StudyPlanCalendarPopover } from '../components/StudyPlanCalendarPopover';
import { getRawDb } from '../db';
import { getCampaignDetail, getNodeAnnotationSummary, getTodayPlan, listCampaigns } from '../data/queries';
import { createCampaign, deleteCampaign } from '../data/mutations';
import { diagnoseExpandNode, diagnoseFetchIntel, diagnoseFromJd } from '../data/diagnosisLocal';
import { createKnowledgeChild, updateKnowledgeNode } from '../data/nodesLocal';
import { generatePlan } from '../data/planLocal';
import { useApp } from '../context/AppContext';
import { runTask, useTaskResult, useTaskState } from '../context/RemoteTaskContext';
import { useLocalDataReload } from '../hooks/useLocalDataReload';
import type { RootTabParamList } from '../navigation/RootTabs';
import { useTheme, type Palette } from '../theme';

const CREATE_CAMPAIGN_KEY = 'campaign:create';

function lastNodeKey(campaignId: string): string {
  return `ui.lastNode.${campaignId}`;
}

function readLastNodeId(campaignId: string): string | null {
  return getRawDb().getFirstSync<{ value: string }>(
    `SELECT value FROM sync_meta WHERE key = ?`,
    lastNodeKey(campaignId),
  )?.value ?? null;
}

function writeLastNodeId(campaignId: string, nodeId: string): void {
  getRawDb().runSync(
    `INSERT INTO sync_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    lastNodeKey(campaignId),
    nodeId,
  );
}

function CampaignListView({
  onOpenDetail,
}: {
  onOpenDetail: (id: string) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const { triggerSync, notifyDataChanged } = useApp();
  const { running: creating } = useTaskState(CREATE_CAMPAIGN_KEY);
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [company, setCompany] = useState('');
  const [role, setRole] = useState('');
  const [jd, setJd] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  const reload = useCallback(() => setCampaigns(listCampaigns(getRawDb())), []);

  useLocalDataReload(reload);

  // 创建在任务里落库，跑完后即使这页被重建也能接着打开详情
  useTaskResult<string>(CREATE_CAMPAIGN_KEY, (id) => {
    setCompany('');
    setRole('');
    setJd('');
    setCreateOpen(false);
    onOpenDetail(id);
  });

  const create = (): void => {
    const input = { company, role, jd };
    void runTask(
      CREATE_CAMPAIGN_KEY,
      '创建备考',
      async () => {
        const id = await createCampaign(getRawDb(), input.company, input.role, input.jd);
        notifyDataChanged();
        await triggerSync().catch(() => undefined);
        return id;
      },
      // 结果是新备考的 id，给用户看的得另写一句
      { successMessage: '备考已创建' },
    ).catch(() => undefined);
  };

  const remove = (campaign: CampaignSummary): void => {
    Alert.alert(
      '删除备考职位',
      `确定删除「${campaign.company} · ${campaign.roleTitle}」吗？相关考点、计划和讲解也会一起删除。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => {
            void runTask(`campaign:delete:${campaign.id}`, '删除备考', async () => {
              await deleteCampaign(getRawDb(), campaign.id);
              notifyDataChanged();
              await triggerSync().catch(() => undefined);
              reload();
              return '备考已删除';
            }).catch(() => undefined);
          },
        },
      ],
    );
  };

  return (
    <>
      <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: 16, gap: 10 }}>
        {campaigns.length === 0 && (
          <Text style={{ color: theme.muted, fontSize: 13 }}>暂无备考，可创建新职位或从桌面端同步</Text>
        )}
        {campaigns.map((c) => (
          <View
            key={c.id}
            style={[
              cardStyle(theme),
              { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
            ]}
          >
            <Pressable onPress={() => onOpenDetail(c.id)} style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: theme.text }}>{c.company} · {c.roleTitle}</Text>
              <Text style={{ color: theme.muted, fontSize: 11 }}>{c.nodeCount} 考点 · {c.status}</Text>
            </Pressable>
            <Pressable onPress={() => remove(c)} hitSlop={8}>
              <Text style={{ color: theme.danger, fontSize: 12 }}>删除</Text>
            </Pressable>
          </View>
        ))}
        <Pressable
          onPress={() => setCreateOpen(true)}
          style={[btnStyle(theme), { marginTop: campaigns.length ? 4 : 0 }]}
        >
          <Text style={{ color: '#fff' }}>创建备考职位</Text>
        </Pressable>
      </ScrollView>

      <Modal visible={createOpen} transparent animationType="fade" onRequestClose={() => setCreateOpen(false)}>
        <Pressable
          onPress={() => setCreateOpen(false)}
          style={{
            flex: 1,
            backgroundColor: theme.scrim,
            justifyContent: 'center',
            padding: 18,
          }}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              gap: 10,
              borderRadius: 16,
              borderWidth: 1,
              borderColor: theme.border,
              backgroundColor: theme.surface,
              padding: 16,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={{ color: theme.text, fontSize: 16, fontWeight: '600' }}>创建备考职位</Text>
              <Pressable onPress={() => setCreateOpen(false)} hitSlop={8}>
                <Text style={{ color: theme.muted, fontSize: 13 }}>关闭</Text>
              </Pressable>
            </View>
            <TextInput
              placeholder="公司"
              placeholderTextColor={theme.muted}
              value={company}
              onChangeText={setCompany}
              editable={!creating}
              style={inputStyle(theme)}
            />
            <TextInput
              placeholder="岗位"
              placeholderTextColor={theme.muted}
              value={role}
              onChangeText={setRole}
              editable={!creating}
              style={inputStyle(theme)}
            />
            <TextInput
              placeholder="JD"
              placeholderTextColor={theme.muted}
              value={jd}
              onChangeText={setJd}
              editable={!creating}
              multiline
              style={[inputStyle(theme), { minHeight: 120, textAlignVertical: 'top' }]}
            />
            <Pressable
              onPress={create}
              disabled={creating || !company.trim() || !role.trim() || !jd.trim()}
              style={[
                btnStyle(theme),
                { opacity: creating || !company.trim() || !role.trim() || !jd.trim() ? 0.55 : 1 },
              ]}
            >
              <Text style={{ color: '#fff' }}>{creating ? '创建中…' : '创建'}</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function CampaignDetailView({
  id,
  initialNodeId,
  initialNodeKey,
  onBack,
}: {
  id: string;
  initialNodeId?: string;
  initialNodeKey?: number;
  onBack: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const scrollRef = useRef<ScrollView>(null);
  const { triggerSync, notifyDataChanged } = useApp();
  // 三个动作各有自己的 key：切页、返回列表再进来都能看到它还在跑
  const diagnoseKey = `campaign:${id}:diagnose`;
  const intelKey = `campaign:${id}:intel`;
  const planKey = `campaign:${id}:planGenerate`;
  const { running: diagnosing } = useTaskState(diagnoseKey);
  const { running: fetchingIntel } = useTaskState(intelKey);
  const [detail, setDetail] = useState(() => getCampaignDetail(getRawDb(), id));
  const [nodeAnnotations, setNodeAnnotations] = useState(() =>
    getNodeAnnotationSummary(getRawDb(), id),
  );
  const [selectedNode, setSelectedNode] = useState<KnowledgeNodeView | null>(null);
  const [nodeStudyMode, setNodeStudyMode] = useState<'explain' | 'drill' | 'followUp'>('explain');
  const [interviewDate, setInterviewDate] = useState(detail.campaign.interviewDate ?? '');
  const [dailyMinutes, setDailyMinutes] = useState(String(detail.campaign.dailyMinutes ?? 90));
  const [calendarFilterDate, setCalendarFilterDate] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<NodeStatus | 'all'>('all');
  const [markFilter, setMarkFilter] = useState<'all' | 'bookmarked' | 'marked' | 'last'>('all');
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [expandingNodeId, setExpandingNodeId] = useState<string | null>(null);
  const [lastNodeId, setLastNodeId] = useState<string | null>(() => readLastNodeId(id));
  const [appliedInitialNodeKey, setAppliedInitialNodeKey] = useState('');

  // setDetail 每次都换新对象，重渲染由它带动，不需要额外的计数器
  const reload = useCallback(() => {
    const next = getCampaignDetail(getRawDb(), id);
    setDetail(next);
    setNodeAnnotations(getNodeAnnotationSummary(getRawDb(), id));
    setInterviewDate(next.campaign.interviewDate ?? '');
    setDailyMinutes(String(next.campaign.dailyMinutes ?? 90));
  }, [id]);

  useLocalDataReload(reload);

  const filterPlan = calendarFilterDate ? getTodayPlan(getRawDb(), id, calendarFilterDate) : null;
  const visibleNodeIds = useMemo(() => {
    const calendarIds = calendarFilterDate && filterPlan ? nodeIdsForPlanFilter(detail.nodes, filterPlan.tasks) : null;
    const hasListFilter = statusFilter !== 'all' || markFilter !== 'all';
    if (!calendarIds && !hasListFilter) return null;

    const matched = detail.nodes
      .filter((node) => !calendarIds || calendarIds.has(node.id))
      .filter((node) => statusFilter === 'all' || node.status === statusFilter)
      .filter((node) => {
        if (markFilter === 'all') return true;
        if (markFilter === 'bookmarked') return nodeAnnotations.bookmarkedIds.has(node.id);
        if (markFilter === 'marked') return nodeAnnotations.markedIds.has(node.id);
        return node.id === lastNodeId;
      })
      .map((node) => node.id);

    const treeIds = hasListFilter ? nodeIdsForTreeFilter(detail.nodes, matched) : (calendarIds ?? new Set<string>());
    if (!calendarIds) return treeIds;
    return new Set([...treeIds].filter((nodeId) => calendarIds.has(nodeId)));
  }, [
    calendarFilterDate,
    detail.nodes,
    filterPlan,
    lastNodeId,
    markFilter,
    nodeAnnotations,
    statusFilter,
  ]);

  const selectNodeForStudy = (
    node: KnowledgeNodeView,
    mode: typeof nodeStudyMode = 'explain',
    options?: { toggle?: boolean },
  ): void => {
    if (options?.toggle && selectedNode?.id === node.id) {
      setSelectedNode(null);
      return;
    }
    setSelectedNode(node);
    setNodeStudyMode(mode);
    setLastNodeId(node.id);
    writeLastNodeId(id, node.id);
  };

  const openTaskInStudy = (task: TaskView): void => {
    if (!task.nodeId) return;
    const node = detail.nodes.find((n) => n.id === task.nodeId);
    if (!node) return;
    selectNodeForStudy(node, task.kind === 'drill' ? 'drill' : 'explain');
  };

  // 结果都写进了 SQLite，任务里通知一次数据变化，界面无论在不在都会重新读库
  const afterWrite = useCallback(async () => {
    notifyDataChanged();
    await triggerSync().catch(() => undefined);
  }, [notifyDataChanged, triggerSync]);

  const diagnose = (): void => {
    void runTask(diagnoseKey, 'JD 诊断', async () => {
      const res = await diagnoseFromJd(getRawDb(), id);
      await afterWrite();
      return res;
    }).catch(() => undefined);
  };

  const fetchIntel = (): void => {
    void runTask(intelKey, '公司情报', async () => {
      const res = await diagnoseFetchIntel(getRawDb(), id);
      await afterWrite();
      return res;
    }).catch(() => undefined);
  };

  const expandNode = (nodeId: string): void => {
    if (expandingNodeId) return;
    const taskKey = `campaign:${id}:expandNode:${nodeId}`;
    setExpandingNodeId(nodeId);
    void runTask(taskKey, '细化考点', async () => {
      const result = await diagnoseExpandNode(getRawDb(), nodeId);
      await afterWrite();
      reload();
      return result;
    })
      .catch(() => undefined)
      .finally(() => setExpandingNodeId(null));
  };

  const updateNode = (nodeId: string, patch: NodePatch): void => {
    const taskKey = `node:${nodeId}:update`;
    void runTask(taskKey, '更新学习进度', async () => {
      await updateKnowledgeNode(getRawDb(), nodeId, patch);
      await afterWrite();
      reload();
      const nextStatus = patch.status;
      if (nextStatus) {
        setSelectedNode((prev) => (prev?.id === nodeId ? { ...prev, status: nextStatus } : prev));
      }
      return '学习进度已更新';
    }).catch(() => undefined);
  };

  const createChildNode = (parentId: string, name: string): void => {
    const taskKey = `node:${parentId}:createChild`;
    void runTask(taskKey, '添加子考点', async () => {
      await createKnowledgeChild(getRawDb(), parentId, name);
      await afterWrite();
      reload();
      return '子考点已添加';
    }).catch(() => undefined);
  };

  const generatePlanAction = (): Promise<unknown> => {
    const input = { interviewDate, dailyMinutes };
    return runTask(planKey, '生成计划', async () => {
      const result = await generatePlan(
        getRawDb(),
        id,
        input.interviewDate || undefined,
        Number(input.dailyMinutes) || 90,
      );
      await afterWrite();
      return `已生成 ${result.daysCreated} 天计划、${result.tasksCreated} 个任务`;
    }).catch(() => undefined);
  };

  // 诊断/情报会长出新考点，跑完后补一次读库。
  // planKey 的结果由日历弹窗认领（一个 key 只能被领走一次），它会回调 onTasksChanged 触发这里的 reload
  useTaskResult(diagnoseKey, reload);
  useTaskResult(intelKey, reload);

  const initialNodeRequestKey = initialNodeId ? `${initialNodeId}:${initialNodeKey ?? 0}` : '';
  if (initialNodeId && initialNodeRequestKey !== appliedInitialNodeKey) {
    const node = detail.nodes.find((n) => n.id === initialNodeId);
    if (node) {
      setAppliedInitialNodeKey(initialNodeRequestKey);
      setCalendarFilterDate(null);
      setStatusFilter('all');
      setMarkFilter('all');
      setSelectedNode(node);
      setNodeStudyMode('explain');
      setLastNodeId(node.id);
      writeLastNodeId(id, node.id);
    }
  }

  return (
    <>
    <ScrollView
      ref={scrollRef}
      style={{ flex: 1, backgroundColor: theme.bg }}
      contentContainerStyle={{ padding: 16, gap: 10 }}
    >
      <Pressable onPress={onBack}>
        <Text style={{ color: theme.accent }}>← 返回列表</Text>
      </Pressable>
      <Text style={{ color: theme.text, fontSize: 18, fontWeight: '600' }}>
        {detail.campaign.company} · {detail.campaign.roleTitle}
      </Text>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Pressable
          onPress={diagnose}
          disabled={diagnosing}
          style={{ backgroundColor: theme.accent, padding: 10, borderRadius: 8, opacity: diagnosing ? 0.6 : 1 }}
        >
          <Text style={{ color: '#fff', fontSize: 12 }}>{diagnosing ? '诊断中…' : 'JD 诊断'}</Text>
        </Pressable>
        <Pressable
          onPress={fetchIntel}
          disabled={fetchingIntel}
          style={{
            borderWidth: 1,
            borderColor: theme.border,
            padding: 10,
            borderRadius: 8,
            opacity: fetchingIntel ? 0.6 : 1,
          }}
        >
          <Text style={{ color: theme.text, fontSize: 12 }}>{fetchingIntel ? '生成中…' : '公司情报'}</Text>
        </Pressable>
      </View>

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
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {[
          ['all', '全部状态'],
          ['todo', '未开始'],
          ['learning', '学习中'],
          ['shaky', '不牢'],
          ['mastered', '已掌握'],
        ].map(([value, label]) => (
          <Pressable
            key={value}
            onPress={() => setStatusFilter(value as NodeStatus | 'all')}
            style={{
              borderWidth: 1,
              borderColor: statusFilter === value ? theme.accent : theme.border,
              backgroundColor: statusFilter === value ? `${theme.accent}18` : theme.surface,
              borderRadius: 999,
              paddingHorizontal: 10,
              paddingVertical: 6,
            }}
          >
            <Text style={{ color: statusFilter === value ? theme.accent : theme.muted, fontSize: 11 }}>
              {label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {[
          ['all', '全部标记'],
          ['bookmarked', '收藏'],
          ['marked', '有笔记/高亮'],
          ['last', '上次学习'],
        ].map(([value, label]) => (
          <Pressable
            key={value}
            onPress={() => setMarkFilter(value as 'all' | 'bookmarked' | 'marked' | 'last')}
            disabled={value === 'last' && !lastNodeId}
            style={{
              borderWidth: 1,
              borderColor: markFilter === value ? theme.accent : theme.border,
              backgroundColor: markFilter === value ? `${theme.accent}18` : theme.surface,
              borderRadius: 999,
              paddingHorizontal: 10,
              paddingVertical: 6,
              opacity: value === 'last' && !lastNodeId ? 0.5 : 1,
            }}
          >
            <Text style={{ color: markFilter === value ? theme.accent : theme.muted, fontSize: 11 }}>
              {label}
            </Text>
          </Pressable>
        ))}
        <Pressable
          onPress={() => {
            const node = detail.nodes.find((n) => n.id === lastNodeId);
            if (!node) return;
            setMarkFilter('last');
            selectNodeForStudy(node);
          }}
          disabled={!lastNodeId || !detail.nodes.some((n) => n.id === lastNodeId)}
          style={{
            borderWidth: 1,
            borderColor: theme.border,
            borderRadius: 999,
            paddingHorizontal: 10,
            paddingVertical: 6,
            opacity: !lastNodeId ? 0.5 : 1,
          }}
        >
          <Text style={{ color: theme.accent, fontSize: 11 }}>继续上次</Text>
        </Pressable>
        {(calendarFilterDate || statusFilter !== 'all' || markFilter !== 'all') && (
          <Pressable
            onPress={() => {
              setCalendarFilterDate(null);
              setStatusFilter('all');
              setMarkFilter('all');
            }}
            style={{
              borderWidth: 1,
              borderColor: theme.border,
              borderRadius: 999,
              paddingHorizontal: 10,
              paddingVertical: 6,
            }}
          >
            <Text style={{ color: theme.muted, fontSize: 11 }}>清空过滤</Text>
          </Pressable>
        )}
      </ScrollView>
      <KnowledgeTree
        nodes={detail.nodes}
        visibleNodeIds={visibleNodeIds}
        selectedNodeId={selectedNode?.id ?? null}
        expandingId={expandingNodeId}
        scrollContainerRef={scrollRef}
        renderNodeDetail={(node) => {
          if (selectedNode?.id !== node.id) return null;
          return (
            <View style={[sectionStyle(theme), { marginTop: 6 }]}>
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
                  <Text style={{ color: nodeStudyMode === 'explain' ? '#fff' : theme.muted, fontSize: 12 }}>
                    讲解
                  </Text>
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
                  <Text style={{ color: nodeStudyMode === 'drill' ? '#fff' : theme.muted, fontSize: 12 }}>
                    考我
                  </Text>
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
                  <Text style={{ color: nodeStudyMode === 'followUp' ? '#fff' : theme.muted, fontSize: 12 }}>
                    追问
                  </Text>
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
          );
        }}
        onSelectNode={(nodeId) => {
          const node = detail.nodes.find((n) => n.id === nodeId);
          if (!node) return;
          selectNodeForStudy(node, 'explain', { toggle: true });
        }}
        onExpand={expandNode}
        onUpdate={updateNode}
        onCreateChild={createChildNode}
      />
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
      planMsg={null}
      onGeneratePlan={generatePlanAction}
      planTaskKey={planKey}
      filterDate={calendarFilterDate}
      onFilterDateChange={setCalendarFilterDate}
      onOpenTask={openTaskInStudy}
      onTasksChanged={async () => {
        await triggerSync();
        reload();
      }}
    />
    </>
  );
}

type CampaignsProps = BottomTabScreenProps<RootTabParamList, 'Campaigns'>;

export function CampaignsScreen({ route }: CampaignsProps): React.JSX.Element {
  const [detailId, setDetailId] = useState<string | null>(null);
  const [focusNodeId, setFocusNodeId] = useState<string | undefined>(undefined);
  const [focusKey, setFocusKey] = useState<number | undefined>(undefined);
  const [handledRouteKey, setHandledRouteKey] = useState('');
  const [mountedDetails, setMountedDetails] = useState<Set<string>>(() => new Set());

  const openDetail = useCallback((id: string, nodeId?: string, key?: number) => {
    setDetailId(id);
    setFocusNodeId(nodeId);
    setFocusKey(key);
    setMountedDetails((prev) => new Set(prev).add(id));
  }, []);

  const routeKey = route.params?.campaignId
    ? `${route.params.campaignId}:${route.params.nodeId ?? ''}:${route.params.focusKey ?? 0}`
    : '';
  if (route.params?.campaignId && routeKey !== handledRouteKey) {
    setHandledRouteKey(routeKey);
    openDetail(route.params.campaignId, route.params.nodeId, route.params.focusKey);
  }

  return (
    <View style={{ flex: 1 }}>
      <KeepAlivePanel active={detailId === null}>
          <CampaignListView onOpenDetail={(id) => openDetail(id)} />
      </KeepAlivePanel>
      {[...mountedDetails].map((id) => (
        <KeepAlivePanel key={id} active={detailId === id}>
          <CampaignDetailView
            id={id}
            initialNodeId={detailId === id ? focusNodeId : undefined}
            initialNodeKey={detailId === id ? focusKey : undefined}
            onBack={() => setDetailId(null)}
          />
        </KeepAlivePanel>
      ))}
    </View>
  );
}

const inputStyle = (theme: Palette) => ({ color: theme.text, borderWidth: 1, borderColor: theme.border, borderRadius: 8, padding: 10 });
const btnStyle = (theme: Palette) => ({ backgroundColor: theme.accent, padding: 12, borderRadius: 8, alignItems: 'center' as const });
const cardStyle = (theme: Palette) => ({ borderWidth: 1, borderColor: theme.border, borderRadius: 8, padding: 12, backgroundColor: theme.surface });
const sectionStyle = (theme: Palette) => ({ borderWidth: 1, borderColor: theme.border, borderRadius: 8, padding: 12, backgroundColor: theme.surface, gap: 8 });
