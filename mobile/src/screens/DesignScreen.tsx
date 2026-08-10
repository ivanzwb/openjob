import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { DesignCaseResult, DesignSubmitResult, MockInterviewType } from '@shared/ipc';
import { MOCK_INTERVIEW_TYPE_LABELS, MOCK_INTERVIEW_TYPE_OPTIONS } from '@shared/ipc';
import { getRawDb } from '../db';
import { listCampaigns } from '../data/queries';
import { invokeRemote } from '../remote/rpc';
import { useApp } from '../context/AppContext';
import { useRemoteTask } from '../context/RemoteTaskContext';
import { theme } from '../theme';

export function DesignScreen(): React.JSX.Element {
  const { triggerSync } = useApp();
  const { runTask, active } = useRemoteTask();
  const campaigns = listCampaigns(getRawDb());
  const [campaignId, setCampaignId] = useState(campaigns[0]?.id ?? '');
  const [interviewType, setInterviewType] = useState<MockInterviewType>('mixed');
  const [designCase, setDesignCase] = useState<DesignCaseResult | null>(null);
  const [answer, setAnswer] = useState('');
  const [result, setResult] = useState<DesignSubmitResult | null>(null);

  const loadCase = async () => {
    try {
      await runTask('模拟面试出题', async () => {
        const { result: res } = await invokeRemote('design:case', { campaignId, interviewType });
        setDesignCase(res as DesignCaseResult);
        setResult(null);
        setAnswer('');
      });
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const submit = async () => {
    if (!designCase) return;
    try {
      await runTask('模拟面试评分', async () => {
        const { result: res } = await invokeRemote('design:submit', {
          campaignId,
          caseTitle: designCase.title,
          scenarioMd: designCase.scenarioMd,
          userAnswer: answer,
          interviewType: designCase.interviewType,
        });
        setResult(res as DesignSubmitResult);
        await triggerSync();
      });
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const busy = Boolean(active);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: 16, gap: 10 }}>
      <Text style={{ color: theme.text, fontSize: 20, fontWeight: '600' }}>模拟面试</Text>
      <Text style={{ color: theme.muted, fontSize: 12 }}>
        结合公司、JD、简历与考点出题，覆盖概念、编码、系统设计、项目场景
      </Text>

      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        {campaigns.map((c) => (
          <Pressable
            key={c.id}
            onPress={() => setCampaignId(c.id)}
            style={{
              marginRight: 8,
              padding: 8,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: campaignId === c.id ? theme.accent : theme.border,
            }}
          >
            <Text style={{ color: theme.text, fontSize: 11 }}>{c.company}</Text>
          </Pressable>
        ))}
      </ScrollView>

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
        onPress={() => void loadCase()}
        disabled={busy || !campaignId}
        style={{
          backgroundColor: theme.accent,
          padding: 12,
          borderRadius: 8,
          alignItems: 'center',
          opacity: busy || !campaignId ? 0.6 : 1,
        }}
      >
        <Text style={{ color: '#fff' }}>{busy ? '生成中…' : '开始模拟（桌面代理）'}</Text>
      </Pressable>

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
            onPress={() => void submit()}
            disabled={busy || !answer.trim()}
            style={{
              backgroundColor: theme.accent,
              padding: 12,
              borderRadius: 8,
              alignItems: 'center',
              opacity: busy || !answer.trim() ? 0.6 : 1,
            }}
          >
            <Text style={{ color: '#fff' }}>提交评分</Text>
          </Pressable>
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
