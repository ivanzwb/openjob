import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { TaskView } from '@shared/ipc';
import { StudyPlanCalendar, todayLocal } from './StudyPlanCalendar';
import { getRawDb } from '../db';
import { getTodayPlan, listPlanDates } from '../data/queries';
import { completeTask, skipTask } from '../data/mutations';
import { deferToday } from '../data/planLocal';
import { runTask, useTaskResult, useTaskState } from '../context/RemoteTaskContext';
import { theme } from '../theme';

export function StudyPlanCalendarPopover({
  open,
  onClose,
  campaignId,
  nodeCount,
  interviewDate,
  dailyMinutes,
  onInterviewDateChange,
  onDailyMinutesChange,
  planMsg,
  onGeneratePlan,
  planTaskKey,
  filterDate,
  onFilterDateChange,
  onOpenTask,
  onTasksChanged,
}: {
  open: boolean;
  onClose: () => void;
  campaignId: string;
  nodeCount: number;
  interviewDate: string;
  dailyMinutes: string;
  onInterviewDateChange: (value: string) => void;
  onDailyMinutesChange: (value: string) => void;
  planMsg: string | null;
  onGeneratePlan: () => void;
  /** 生成计划的任务标识由上层给出，关掉弹窗再打开仍能看到进度 */
  planTaskKey: string;
  filterDate: string | null;
  onFilterDateChange: (date: string | null) => void;
  onOpenTask: (task: TaskView) => void;
  onTasksChanged: () => void | Promise<void>;
}): React.JSX.Element {
  const [setupOpen, setSetupOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => new Date());
  const [tick, setTick] = useState(0);
  const deferKey = `campaign:${campaignId}:planDefer`;
  const { running: generating } = useTaskState(planTaskKey);
  const { running: deferring } = useTaskState(deferKey);

  const dateOptions = useMemo(
    () => (open ? listPlanDates(getRawDb(), campaignId) : []),
    [open, campaignId, tick],
  );
  const hasPlan = dateOptions.length > 0;
  const taskCountByDate = useMemo(
    () => Object.fromEntries(dateOptions.map((d) => [d.date, d.taskCount])),
    [dateOptions],
  );
  const filterPlan = filterDate && open ? getTodayPlan(getRawDb(), campaignId, filterDate) : null;

  useEffect(() => {
    if (!open) return;
    if (dateOptions.length === 0) setSetupOpen(true);
  }, [open, dateOptions.length]);

  useEffect(() => {
    if (!filterDate) return;
    const [y, m] = filterDate.split('-').map(Number);
    if (y && m) setViewMonth(new Date(y, m - 1, 1));
  }, [filterDate]);

  const refresh = async (): Promise<void> => {
    setTick((t) => t + 1);
    await onTasksChanged();
  };

  // 生成与顺延都在全局任务里跑：关掉弹窗、切页再回来都能接上
  useTaskResult(planTaskKey, () => {
    setSetupOpen(false);
    void refresh();
  });
  useTaskResult(deferKey, () => void refresh());

  const complete = (taskId: string): void => {
    void runTask(`task:complete:${taskId}`, '完成任务', async () => {
      await completeTask(getRawDb(), taskId);
      return '已完成';
    })
      .then(() => refresh())
      .catch(() => undefined);
  };

  const skip = (taskId: string): void => {
    void runTask(`task:skip:${taskId}`, '跳过任务', async () => {
      await skipTask(getRawDb(), taskId);
      return '已跳过';
    })
      .then(() => refresh())
      .catch(() => undefined);
  };

  const defer = (): void => {
    void runTask(deferKey, '顺延', async () => {
      await deferToday(getRawDb(), campaignId);
      return '今天未完成的任务已顺延';
    }).catch(() => undefined);
  };

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'center', padding: 16 }}>
        <Pressable
          style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(0,0,0,0.45)' }}
          onPress={onClose}
        />
        <View
          style={{
            maxHeight: '85%',
            borderRadius: 12,
            borderWidth: 1,
            borderColor: theme.border,
            backgroundColor: theme.surface,
            padding: 14,
            gap: 10,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={{ color: theme.text, fontWeight: '600', fontSize: 15 }}>学习日历</Text>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              {filterDate && (
                <Pressable onPress={() => onFilterDateChange(null)}>
                  <Text style={{ color: theme.accent, fontSize: 12 }}>清除筛选</Text>
                </Pressable>
              )}
              {hasPlan && (
                <Pressable onPress={() => setSetupOpen((v) => !v)}>
                  <Text style={{ color: theme.muted, fontSize: 12 }}>{setupOpen ? '收起编排' : '编排'}</Text>
                </Pressable>
              )}
              <Pressable onPress={onClose}>
                <Text style={{ color: theme.muted, fontSize: 12 }}>关闭</Text>
              </Pressable>
            </View>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
            {(setupOpen || !hasPlan) && (
              <View style={{ gap: 8 }}>
                <TextInput
                  placeholder="面试日期 YYYY-MM-DD"
                  placeholderTextColor={theme.muted}
                  value={interviewDate}
                  onChangeText={onInterviewDateChange}
                  style={inputStyle}
                />
                <TextInput
                  placeholder="每日分钟"
                  placeholderTextColor={theme.muted}
                  value={dailyMinutes}
                  onChangeText={onDailyMinutesChange}
                  keyboardType="number-pad"
                  style={inputStyle}
                />
                <Pressable
                  onPress={onGeneratePlan}
                  disabled={generating || nodeCount === 0}
                  style={{
                    backgroundColor: '#047857',
                    padding: 10,
                    borderRadius: 8,
                    alignItems: 'center',
                    opacity: generating || nodeCount === 0 ? 0.6 : 1,
                  }}
                >
                  <Text style={{ color: '#fff' }}>
                    {generating ? '生成中…' : hasPlan ? '重新生成计划' : '生成计划'}
                  </Text>
                </Pressable>
                {planMsg && (
                  <Text style={{ color: planMsg.includes('已生成') ? theme.success : theme.danger, fontSize: 12 }}>
                    {planMsg}
                  </Text>
                )}
              </View>
            )}

            {hasPlan ? (
              <>
                <StudyPlanCalendar
                  viewMonth={viewMonth}
                  onViewMonthChange={setViewMonth}
                  taskCountByDate={taskCountByDate}
                  selectedDate={filterDate}
                  onSelectDate={onFilterDateChange}
                  interviewDate={interviewDate || undefined}
                />

                {filterDate && filterPlan && (
                  <View style={{ gap: 6 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text style={{ color: theme.muted, fontSize: 11 }}>
                        {filterDate}
                        {filterDate === todayLocal() ? ' · 今天' : ''} · {filterPlan.completedCount}/{filterPlan.totalCount}
                      </Text>
                      {filterDate === todayLocal() &&
                        filterPlan.planDay &&
                        filterPlan.completedCount < filterPlan.totalCount && (
                          <Pressable disabled={deferring} onPress={defer}>
                            <Text style={{ color: theme.accent, fontSize: 11 }}>
                              {deferring ? '顺延中…' : '顺延'}
                            </Text>
                          </Pressable>
                        )}
                    </View>
                    {filterPlan.tasks.length === 0 ? (
                      <Text style={{ color: theme.muted, fontSize: 11 }}>该日无任务</Text>
                    ) : (
                      filterPlan.tasks.map((t) => (
                        <DayTaskRow
                          key={t.id}
                          task={t}
                          onOpen={() => {
                            onOpenTask(t);
                            onClose();
                          }}
                          onComplete={() => complete(t.id)}
                          onSkip={() => skip(t.id)}
                        />
                      ))
                    )}
                  </View>
                )}
              </>
            ) : (
              <Text style={{ color: theme.muted, fontSize: 12 }}>生成计划后，点击日期筛选考点清单</Text>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function DayTaskRow({
  task,
  onOpen,
  onComplete,
  onSkip,
}: {
  task: TaskView;
  onOpen: () => void;
  onComplete: () => void;
  onSkip: () => void;
}): React.JSX.Element {
  const done = task.status === 'done';
  const skipped = task.status === 'skipped';
  const canOpen = Boolean(task.nodeId) && !done && !skipped;
  const { running: completing } = useTaskState(`task:complete:${task.id}`);
  const { running: skipping } = useTaskState(`task:skip:${task.id}`);

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: theme.border,
        borderRadius: 8,
        padding: 8,
        backgroundColor: theme.bg,
        gap: 4,
      }}
    >
      <Pressable disabled={!canOpen} onPress={onOpen}>
        <Text
          style={{
            color: done ? theme.muted : theme.text,
            fontSize: 12,
            textDecorationLine: done ? 'line-through' : 'none',
          }}
        >
          {task.nodeName ?? task.repoUrl ?? task.kind}
          {canOpen ? ' →' : ''}
        </Text>
      </Pressable>
      {!done && !skipped && (
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <Pressable onPress={onComplete} disabled={completing || skipping}>
            <Text style={{ color: theme.accent, fontSize: 11, opacity: completing || skipping ? 0.5 : 1 }}>
              {completing ? '处理中…' : '完成'}
            </Text>
          </Pressable>
          <Pressable onPress={onSkip} disabled={completing || skipping}>
            <Text style={{ color: theme.muted, fontSize: 11, opacity: completing || skipping ? 0.5 : 1 }}>
              {skipping ? '处理中…' : '跳过'}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const inputStyle = {
  color: theme.text,
  borderWidth: 1,
  borderColor: theme.border,
  borderRadius: 8,
  padding: 10,
};
