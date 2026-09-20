import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { CampaignSummary } from '@core/ipc';
import type { PracticeEvaluation, PracticeSession } from '@core/practice';
import { MarkdownPreview } from '../components/MarkdownPreview';
import { VoiceInputButton } from '../components/VoiceInputButton';
import {
  answerPracticeTurn,
  evaluatePractice,
  listPracticeHistory,
  practiceAttemptScores,
  practiceFormatOptions,
  startPracticeSession,
  type PracticeFormatOption,
  type PracticeHistoryItem,
} from '../data/practiceLocal';
import { listMobilePluginRuntimes, type MobilePluginRuntime } from '../data/pluginRuntimeLocal';
import { listCampaigns } from '../data/queries';
import { getRawDb } from '../db';
import { PluginRuntimeView } from './PluginRuntimesScreen';
import { useTheme } from '../theme';

/**
 * 面试：手机端的练习入口（0.6.x 的那一格回到手机上）。
 *
 * 题型与量规来自同步过来的岗位包，出题、追问、评分都在本机跑（`practiceLocal`），
 * 结果写进参与同步的 `practice_*` 表——桌面端看到的是同一份历史与掌握度。
 *
 * 岗位包自己注册的练习页（案例训练、客户对话模拟）也挂在这一格：那是包提供的页面，
 * 宿主不重复实现一遍交互。
 */

function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={{
        borderRadius: 999,
        borderWidth: 1,
        borderColor: active ? theme.accent : theme.border,
        backgroundColor: active ? `${theme.accent}18` : theme.surface,
        paddingHorizontal: 12,
        paddingVertical: 6,
      }}
    >
      <Text style={{ color: active ? theme.accent : theme.text, fontSize: 12 }}>{label}</Text>
    </Pressable>
  );
}

function Card({ children }: { children: React.ReactNode }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={{
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.border,
        backgroundColor: theme.surface,
        padding: 12,
        gap: 6,
      }}
    >
      {children}
    </View>
  );
}

export function InterviewScreen(): React.JSX.Element {
  const theme = useTheme();
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [formats, setFormats] = useState<PracticeFormatOption[]>([]);
  const [formatId, setFormatId] = useState<string | null>(null);
  const [runtimes, setRuntimes] = useState<MobilePluginRuntime[]>([]);
  const [openedRuntime, setOpenedRuntime] = useState<MobilePluginRuntime | null>(null);
  const [session, setSession] = useState<PracticeSession | null>(null);
  const [evaluation, setEvaluation] = useState<PracticeEvaluation | null>(null);
  const [history, setHistory] = useState<PracticeHistoryItem[]>([]);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCampaign = useCallback((id: string | null) => {
    const db = getRawDb();
    setCampaignId(id);
    setSession(null);
    setEvaluation(null);
    setAnswer('');
    setError(null);
    if (!id) {
      setFormats([]);
      setFormatId(null);
      setRuntimes([]);
      setHistory([]);
      return;
    }
    try {
      const options = practiceFormatOptions(db, id);
      setFormats(options);
      setFormatId(options[0]?.id ?? null);
    } catch (cause) {
      // 还没同步到岗位包时这是常态：把原因显示出来，别让界面空着
      setFormats([]);
      setFormatId(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    setRuntimes(listMobilePluginRuntimes(db));
    setHistory(listPracticeHistory(db, id));
  }, []);

  useFocusEffect(
    useCallback(() => {
      const list = listCampaigns(getRawDb());
      setCampaigns(list);
      loadCampaign(list[0]?.id ?? null);
    }, [loadCampaign]),
  );

  const run = async (task: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (openedRuntime) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg }}>
        <Pressable
          onPress={() => setOpenedRuntime(null)}
          style={{ paddingHorizontal: 16, paddingVertical: 10 }}
        >
          <Text style={{ color: theme.accent, fontSize: 13 }}>← 返回面试</Text>
        </Pressable>
        <PluginRuntimeView plugin={openedRuntime} />
      </View>
    );
  }

  const lastTurn = session?.turns.at(-1) ?? null;
  const awaitingAnswer = session?.status === 'open' && lastTurn?.speaker === 'interviewer';
  const readyToEvaluate = session?.status === 'open' && lastTurn?.kind === 'closing';

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.bg }}
      contentContainerStyle={{ padding: 16, gap: 12 }}
    >
      <Text style={{ color: theme.muted, fontSize: 12 }}>
        题型与量规来自同步过来的岗位包；出题、追问与评分都在本机完成，结果会同步回桌面端。
      </Text>

      <Text style={{ color: theme.text, fontSize: 12, fontWeight: '600' }}>备考</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {campaigns.map((campaign) => (
          <Chip
            key={campaign.id}
            label={`${campaign.company} · ${campaign.roleTitle}`}
            active={campaign.id === campaignId}
            onPress={() => loadCampaign(campaign.id)}
          />
        ))}
        {campaigns.length === 0 && (
          <Text style={{ color: theme.muted, fontSize: 12 }}>
            还没有备考，先在桌面端创建并同步过来
          </Text>
        )}
      </View>

      {runtimes.length > 0 && (
        <Card>
          <Text style={{ color: theme.text, fontSize: 12, fontWeight: '600' }}>本岗位的专属练习</Text>
          {runtimes.map((runtime) => (
            <Pressable key={runtime.pluginId} onPress={() => setOpenedRuntime(runtime)}>
              <Text style={{ color: theme.accent, fontSize: 13 }}>
                {runtime.displayName} · 打开包页面
              </Text>
            </Pressable>
          ))}
        </Card>
      )}

      {formats.length > 0 && (
        <Card>
          <Text style={{ color: theme.text, fontSize: 12, fontWeight: '600' }}>题型</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {formats.map((format) => (
              <Chip
                key={format.id}
                label={format.label}
                active={format.id === formatId}
                onPress={() => setFormatId(format.id)}
              />
            ))}
          </View>
          <Pressable
            disabled={busy || !formatId || session?.status === 'open'}
            onPress={() =>
              void run(async () => {
                const started = await startPracticeSession(getRawDb(), {
                  campaignId: campaignId!,
                  formatId: formatId!,
                });
                setSession(started);
                setEvaluation(null);
                setAnswer('');
              })
            }
            style={{
              marginTop: 4,
              borderRadius: 10,
              backgroundColor: busy || !formatId ? theme.border : theme.accent,
              paddingVertical: 10,
              alignItems: 'center',
            }}
          >
            <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>
              {session?.status === 'open' ? '本轮练习进行中' : '开始练习'}
            </Text>
          </Pressable>
        </Card>
      )}

      {session && (
        <Card>
          {session.turns.map((turn) => (
            <View key={turn.id} style={{ gap: 4 }}>
              <Text style={{ color: theme.muted, fontSize: 11 }}>
                {turn.speaker === 'interviewer' ? '面试官' : '我'}
                {turn.kind === 'followUp' ? '（追问）' : ''}
                {turn.kind === 'closing' ? '（收束）' : ''}
              </Text>
              <MarkdownPreview text={turn.contentMd} />
            </View>
          ))}
        </Card>
      )}

      {session && session.status === 'open' && (
        <Card>
          <TextInput
            value={answer}
            onChangeText={setAnswer}
            multiline
            placeholder={awaitingAnswer ? '写下你的回答…' : ''}
            placeholderTextColor={theme.muted}
            style={{
              minHeight: 96,
              borderWidth: 1,
              borderColor: theme.border,
              borderRadius: 8,
              padding: 8,
              color: theme.text,
              textAlignVertical: 'top',
            }}
          />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <VoiceInputButton onTranscript={(text) => setAnswer((prev) => `${prev}${text}`)} />
            <Pressable
              disabled={busy || !answer.trim()}
              onPress={() =>
                void run(async () => {
                  if (readyToEvaluate) {
                    const result = await evaluatePractice(getRawDb(), { sessionId: session.id });
                    setEvaluation(result);
                    setSession(null);
                    if (campaignId) setHistory(listPracticeHistory(getRawDb(), campaignId));
                    return;
                  }
                  const turn = await answerPracticeTurn(getRawDb(), {
                    sessionId: session.id,
                    answerMd: answer.trim(),
                  });
                  setAnswer('');
                  setSession({ ...session, turns: [...session.turns, turn] });
                })
              }
              style={{
                borderRadius: 10,
                backgroundColor: busy || !answer.trim() ? theme.border : theme.accent,
                paddingVertical: 10,
                paddingHorizontal: 16,
              }}
            >
              <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>
                {readyToEvaluate ? '提交评分' : '提交作答'}
              </Text>
            </Pressable>
            {busy && <ActivityIndicator size="small" color={theme.accent} />}
          </View>
        </Card>
      )}

      {evaluation && (
        <Card>
          <Text style={{ color: theme.text, fontSize: 13, fontWeight: '600' }}>
            总分 {evaluation.totalScore.toFixed(1)} / 5
            {evaluation.needsRePractice ? ' · 建议再练一次' : ''}
          </Text>
          {evaluation.scores.map((score) => (
            <View key={score.dimensionId} style={{ gap: 2 }}>
              <Text style={{ color: theme.text, fontSize: 12 }}>
                {score.label}：{score.score} 分（权重 {score.weight}）
              </Text>
              <Text style={{ color: theme.muted, fontSize: 11 }}>依据：{score.answer.quote}</Text>
              <Text style={{ color: theme.muted, fontSize: 11 }}>锚点：{score.anchor.text}</Text>
              {score.rationaleMd !== '' && (
                <Text style={{ color: theme.muted, fontSize: 11 }}>{score.rationaleMd}</Text>
              )}
            </View>
          ))}
          <MarkdownPreview text={evaluation.feedbackMd} />
          {evaluation.improvedScriptMd.trim() !== '' && (
            <>
              <Text style={{ color: theme.text, fontSize: 12, fontWeight: '600' }}>改进后的话术</Text>
              <MarkdownPreview text={evaluation.improvedScriptMd} />
            </>
          )}
        </Card>
      )}

      {history.length > 0 && (
        <Card>
          <Text style={{ color: theme.text, fontSize: 12, fontWeight: '600' }}>历史练习</Text>
          {history.map((item) => (
            <View key={item.id} style={{ gap: 2 }}>
              <Text style={{ color: theme.text, fontSize: 12 }}>
                {new Date(item.createdAt).toLocaleString()} · {item.totalScore.toFixed(1)} 分
                {item.needsRePractice ? ' · 建议复练' : ''}
              </Text>
              <Text style={{ color: theme.muted, fontSize: 11 }} numberOfLines={2}>
                {item.questionMd}
              </Text>
              {practiceAttemptScores(getRawDb(), item.id).length > 0 && (
                <Text style={{ color: theme.muted, fontSize: 11 }}>
                  {practiceAttemptScores(getRawDb(), item.id)
                    .map((score) => `${score.label} ${score.score}`)
                    .join(' · ')}
                </Text>
              )}
            </View>
          ))}
        </Card>
      )}

      {error && <Text style={{ color: '#e5484d', fontSize: 12 }}>{error}</Text>}
    </ScrollView>
  );
}
