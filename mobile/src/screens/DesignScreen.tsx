import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { DesignCaseResult, DesignSubmitResult } from '@shared/ipc';
import { getRawDb } from '../db';
import { listCampaigns } from '../data/queries';
import { invokeRemote } from '../remote/rpc';
import { useApp } from '../context/AppContext';
import { theme } from '../theme';

export function DesignScreen(): React.JSX.Element {
  const { triggerSync } = useApp();
  const campaigns = listCampaigns(getRawDb());
  const [campaignId, setCampaignId] = useState(campaigns[0]?.id ?? '');
  const [designCase, setDesignCase] = useState<DesignCaseResult | null>(null);
  const [answer, setAnswer] = useState('');
  const [result, setResult] = useState<DesignSubmitResult | null>(null);
  const [busy, setBusy] = useState(false);

  const loadCase = async () => {
    setBusy(true);
    try {
      const { result: res } = await invokeRemote('design:case', { campaignId });
      setDesignCase(res as DesignCaseResult);
      setResult(null);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!designCase) return;
    setBusy(true);
    try {
      const { result: res } = await invokeRemote('design:submit', {
        campaignId,
        caseTitle: designCase.title,
        scenarioMd: designCase.scenarioMd,
        userAnswer: answer,
      });
      setResult(res as DesignSubmitResult);
      await triggerSync();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: 16, gap: 10 }}>
      <Text style={{ color: theme.text, fontSize: 20, fontWeight: '600' }}>设计练习</Text>
      <ScrollView horizontal>
        {campaigns.map((c) => (
          <Pressable key={c.id} onPress={() => setCampaignId(c.id)} style={{ marginRight: 8, padding: 8, borderRadius: 8, borderWidth: 1, borderColor: campaignId === c.id ? theme.accent : theme.border }}>
            <Text style={{ color: theme.text, fontSize: 11 }}>{c.company}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <Pressable onPress={() => void loadCase()} style={{ backgroundColor: theme.accent, padding: 12, borderRadius: 8, alignItems: 'center' }}>
        <Text style={{ color: '#fff' }}>{busy ? '生成中…' : '出题（桌面代理）'}</Text>
      </Pressable>
      {designCase && (
        <View style={{ gap: 8 }}>
          <Text style={{ color: theme.text, fontWeight: '600' }}>{designCase.title}</Text>
          <Text style={{ color: theme.muted, fontSize: 12 }}>{designCase.scenarioMd}</Text>
          <TextInput
            multiline
            value={answer}
            onChangeText={setAnswer}
            placeholder="你的回答…"
            placeholderTextColor={theme.muted}
            style={{ minHeight: 120, color: theme.text, borderWidth: 1, borderColor: theme.border, borderRadius: 8, padding: 10, textAlignVertical: 'top' }}
          />
          <Pressable onPress={() => void submit()} style={{ backgroundColor: theme.accent, padding: 12, borderRadius: 8, alignItems: 'center' }}>
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
