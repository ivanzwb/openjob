import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import type { TodayCampaignOption, TodayPlan } from '@shared/ipc';
import { getRawDb } from '../db';
import { getTodayPlan, listTodayCampaigns } from '../data/queries';
import { completeTask, skipTask } from '../data/mutations';
import { useApp } from '../context/AppContext';
import { theme } from '../theme';

export function TodayScreen(): React.JSX.Element {
  const { triggerSync } = useApp();
  const [campaigns, setCampaigns] = useState<TodayCampaignOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [plan, setPlan] = useState<TodayPlan | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    const db = getRawDb();
    const list = listTodayCampaigns(db);
    setCampaigns(list);
    const id = selectedId ?? list[0]?.id ?? null;
    setSelectedId(id);
    setPlan(id ? getTodayPlan(db, id) : null);
  }, [selectedId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      reload();
      await triggerSync();
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ color: theme.text, fontSize: 20, fontWeight: '600' }}>今日</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }}>
        {campaigns.map((c) => (
          <Pressable
            key={c.id}
            onPress={() => setSelectedId(c.id)}
            style={{
              marginRight: 8,
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: selectedId === c.id ? theme.accent : theme.border,
              backgroundColor: theme.surface,
            }}
          >
            <Text style={{ color: theme.text, fontSize: 12 }}>{c.company}</Text>
            <Text style={{ color: theme.muted, fontSize: 10 }}>
              {c.completedCount}/{c.totalCount}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      {busy && <ActivityIndicator color={theme.accent} />}

      {plan && (
        <View style={{ gap: 8 }}>
          <Text style={{ color: theme.muted, fontSize: 12 }}>
            {plan.company} · {plan.roleTitle} · {plan.date}
          </Text>
          {plan.tasks.length === 0 ? (
            <Text style={{ color: theme.muted }}>今天没有任务，可在桌面端生成计划后同步。</Text>
          ) : (
            plan.tasks.map((t) => (
              <View
                key={t.id}
                style={{
                  borderWidth: 1,
                  borderColor: theme.border,
                  borderRadius: 8,
                  padding: 12,
                  backgroundColor: theme.surface,
                  gap: 6,
                }}
              >
                <Text style={{ color: theme.text, fontWeight: '500' }}>
                  {t.nodeName ?? t.repoUrl ?? t.kind}
                </Text>
                <Text style={{ color: theme.muted, fontSize: 11 }}>
                  {t.kind} · {t.estMinutes} 分钟 · {t.status}
                </Text>
                {t.status === 'pending' && (
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <Pressable
                      onPress={() => void act(async () => completeTask(getRawDb(), t.id))}
                      style={{ backgroundColor: theme.accent, padding: 8, borderRadius: 6 }}
                    >
                      <Text style={{ color: '#fff', fontSize: 12 }}>完成</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => void act(async () => skipTask(getRawDb(), t.id))}
                      style={{ borderWidth: 1, borderColor: theme.border, padding: 8, borderRadius: 6 }}
                    >
                      <Text style={{ color: theme.text, fontSize: 12 }}>跳过</Text>
                    </Pressable>
                  </View>
                )}
              </View>
            ))
          )}
        </View>
      )}
    </ScrollView>
  );
}
