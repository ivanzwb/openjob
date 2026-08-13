import { useCallback, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type {
  CampaignSummary,
  DesignCaseResult,
  DesignSubmitResult,
  MockInterviewType,
} from '@shared/ipc';
import { MOCK_INTERVIEW_TYPE_LABELS, MOCK_INTERVIEW_TYPE_OPTIONS } from '@shared/ipc';
import { getRawDb } from '../db';
import { listCampaigns } from '../data/queries';
import { generateDesignCase, submitDesignAnswer } from '../data/designLocal';
import { useApp } from '../context/AppContext';
import { runTask, useTaskResult, useTaskState } from '../context/RemoteTaskContext';
import { useLocalDataReload } from '../hooks/useLocalDataReload';
import { theme } from '../theme';

function campaignLabel(c: CampaignSummary): string {
  return `${c.company} · ${c.roleTitle}`;
}

export function DesignScreen(): React.JSX.Element {
  const { notifyDataChanged } = useApp();
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [campaignId, setCampaignId] = useState('');
  const [interviewType, setInterviewType] = useState<MockInterviewType>('mixed');
  const [designCase, setDesignCase] = useState<DesignCaseResult | null>(null);
  const [answer, setAnswer] = useState('');
  const [result, setResult] = useState<DesignSubmitResult | null>(null);

  const reload = useCallback(() => {
    const list = listCampaigns(getRawDb());
    setCampaigns(list);
    setCampaignId((prev) => {
      if (prev && list.some((c) => c.id === prev)) return prev;
      return list[0]?.id ?? '';
    });
  }, []);

  useLocalDataReload(reload);

  // 出题与评分按 Campaign 记：切到别的 Tab 再回来，题目和评分都还在
  const caseKey = `design:case:${campaignId}`;
  const submitKey = `design:submit:${campaignId}`;
  const { running: loadingCase, error: caseError } = useTaskState(caseKey);
  const { running: submitting, error: submitError } = useTaskState(submitKey);

  useTaskResult<DesignCaseResult>(caseKey, (res) => {
    setDesignCase(res);
    setResult(null);
    setAnswer('');
  });
  useTaskResult<DesignSubmitResult>(submitKey, setResult);

  const loadCase = (): void => {
    const input = { campaignId, interviewType };
    void runTask(caseKey, '模拟面试出题', () =>
      generateDesignCase(getRawDb(), input.campaignId, input.interviewType),
    ).catch(() => undefined);
  };

  const submit = (): void => {
    if (!designCase) return;
    const input = { campaignId, designCase, answer };
    void runTask(submitKey, '模拟面试评分', async () => {
      const res = await submitDesignAnswer(
        getRawDb(),
        input.campaignId,
        input.designCase.title,
        input.designCase.scenarioMd,
        input.answer,
        input.designCase.interviewType,
      );
      notifyDataChanged();
      return res;
    }).catch(() => undefined);
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: 16, gap: 10 }}>
      <Text style={{ color: theme.muted, fontSize: 12 }}>
        结合公司、JD、简历与考点出题，覆盖概念、编码、系统设计、项目场景
      </Text>

      {campaigns.length === 0 ? (
        <Text style={{ color: theme.muted, fontSize: 13 }}>请先创建 Campaign 或从桌面端同步</Text>
      ) : (
        <>
          <Text style={{ color: theme.muted, fontSize: 11 }}>关联 Campaign</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {campaigns.map((c) => (
              <Pressable
                key={c.id}
                onPress={() => {
                  setCampaignId(c.id);
                  setDesignCase(null);
                  setResult(null);
                }}
                style={{
                  marginRight: 8,
                  paddingHorizontal: 10,
                  paddingVertical: 8,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: campaignId === c.id ? theme.accent : theme.border,
                  backgroundColor: campaignId === c.id ? `${theme.accent}18` : theme.surface,
                  maxWidth: 260,
                }}
              >
                <Text style={{ color: theme.text, fontSize: 11 }} numberOfLines={2}>
                  {campaignLabel(c)}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </>
      )}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {MOCK_INTERVIEW_TYPE_OPTIONS.map((o) => (
          <Pressable
            key={o.value}
            onPress={() => {
              setInterviewType(o.value);
              setDesignCase(null);
              setResult(null);
            }}
            style={{
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: interviewType === o.value ? theme.accent : theme.border,
              backgroundColor: theme.surface,
            }}
          >
            <Text style={{ color: interviewType === o.value ? theme.accent : theme.muted, fontSize: 12 }}>
              {o.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      <Pressable
        onPress={loadCase}
        disabled={loadingCase || !campaignId}
        style={{
          backgroundColor: theme.accent,
          padding: 12,
          borderRadius: 8,
          alignItems: 'center',
          opacity: loadingCase || !campaignId ? 0.6 : 1,
        }}
      >
        <Text style={{ color: '#fff' }}>{loadingCase ? '出题中…' : '开始模拟'}</Text>
      </Pressable>
      {caseError !== null && <Text style={{ color: theme.danger, fontSize: 12 }}>{caseError}</Text>}

      {designCase && (
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
            <Text style={{ color: theme.text, fontWeight: '600' }}>{designCase.title}</Text>
            <Text style={{ color: theme.accent, fontSize: 11 }}>
              {MOCK_INTERVIEW_TYPE_LABELS[designCase.interviewType]}
            </Text>
          </View>
          {designCase.relatedNodeName && (
            <Text style={{ color: theme.muted, fontSize: 11 }}>关联考点：{designCase.relatedNodeName}</Text>
          )}
          <Text style={{ color: theme.muted, fontSize: 12 }}>{designCase.scenarioMd}</Text>
          {designCase.constraints.length > 0 && (
            <Text style={{ color: theme.muted, fontSize: 11 }}>
              考察点：{designCase.constraints.join(' · ')}
            </Text>
          )}
          <TextInput
            multiline
            value={answer}
            onChangeText={setAnswer}
            placeholder="你的回答…"
            placeholderTextColor={theme.muted}
            style={{
              minHeight: 120,
              color: theme.text,
              borderWidth: 1,
              borderColor: theme.border,
              borderRadius: 8,
              padding: 10,
              textAlignVertical: 'top',
            }}
          />
          <Pressable
            onPress={submit}
            disabled={submitting || !answer.trim()}
            style={{
              backgroundColor: theme.accent,
              padding: 12,
              borderRadius: 8,
              alignItems: 'center',
              opacity: submitting || !answer.trim() ? 0.6 : 1,
            }}
          >
            <Text style={{ color: '#fff' }}>{submitting ? '评分中…' : '提交评分'}</Text>
          </Pressable>
          {submitError !== null && <Text style={{ color: theme.danger, fontSize: 12 }}>{submitError}</Text>}
        </View>
      )}

      {result && (
        <View style={{ gap: 6 }}>
          <Text style={{ color: theme.success }}>得分 {result.score}/5</Text>
          <Text style={{ color: theme.text, fontSize: 12 }}>{result.feedbackMd}</Text>
        </View>
      )}
    </ScrollView>
  );
}
