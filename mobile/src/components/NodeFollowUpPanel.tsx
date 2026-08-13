import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { completeChat } from '../llm/chat';
import { runTask, useTaskResult, useTaskState } from '../context/RemoteTaskContext';
import { theme } from '../theme';

type Msg = { role: 'user' | 'assistant'; text: string };

/** 考点学习内的多轮追问 */
export function NodeFollowUpPanel({
  nodeId,
  nodeName,
}: {
  campaignId: string;
  nodeId: string;
  nodeName: string;
}): React.JSX.Element {
  // 按考点记这轮追问：切页、换 Tab 再回来还能看到「回答中…」和已经答完的内容
  const taskKey = `node:followUp:${nodeId}`;
  const { running: busy, error } = useTaskState(taskKey);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');

  // 任务返回整段对话，重新挂载后一次补齐提问与回答
  useTaskResult<Msg[]>(taskKey, setMessages);

  const send = (): void => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    const nextMessages = [...messages, { role: 'user' as const, text }];
    setMessages(nextMessages);
    const systemPrompt =
      `用户正在备考，当前学习的考点是「${nodeName}」（nodeId: ${nodeId}）。` +
      '请围绕该考点回答追问：澄清概念、对比易混点、补充面试深挖角度。回答适合口述。';
    void runTask(
      taskKey,
      '追问',
      async () => {
        const reply = await completeChat('explain', [
          { role: 'system', content: systemPrompt },
          ...nextMessages.map((m) => ({ role: m.role, content: m.text })),
        ]);
        return [...nextMessages, { role: 'assistant' as const, text: reply || '（无回复）' }];
      },
      { toastSuccess: false },
    ).catch(() => undefined);
  };

  return (
    <View style={{ gap: 8, minHeight: 240 }}>
      <ScrollView style={{ maxHeight: 280 }} contentContainerStyle={{ gap: 10 }}>
        {messages.length === 0 ? (
          <Text style={{ color: theme.muted, fontSize: 12 }}>
            对「{nodeName}」有什么想追问的？手机端直连 LLM 回答。
          </Text>
        ) : (
          messages.map((m, i) => (
            <View
              key={i}
              style={{
                alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '90%',
                backgroundColor: m.role === 'user' ? theme.accent : theme.bg,
                padding: 10,
                borderRadius: 10,
              }}
            >
              <Text style={{ color: m.role === 'user' ? '#fff' : theme.text, fontSize: 13 }}>
                {m.text}
              </Text>
            </View>
          ))
        )}
        {busy && <Text style={{ color: theme.muted, fontSize: 12 }}>回答中…</Text>}
        {error !== null && <Text style={{ color: theme.danger, fontSize: 12 }}>{error}</Text>}
      </ScrollView>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder={`追问「${nodeName}」…`}
          placeholderTextColor={theme.muted}
          multiline
          style={{
            flex: 1,
            minHeight: 44,
            color: theme.text,
            borderWidth: 1,
            borderColor: theme.border,
            borderRadius: 8,
            paddingHorizontal: 10,
            paddingVertical: 8,
            textAlignVertical: 'top',
          }}
        />
        <Pressable
          onPress={send}
          disabled={busy || !input.trim()}
          style={{
            backgroundColor: theme.accent,
            paddingHorizontal: 14,
            justifyContent: 'center',
            borderRadius: 8,
            opacity: busy || !input.trim() ? 0.6 : 1,
          }}
        >
          <Text style={{ color: '#fff' }}>{busy ? '…' : '发送'}</Text>
        </Pressable>
      </View>
    </View>
  );
}
