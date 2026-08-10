import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { ChatMessage } from '@shared/ipc';
import { invokeRemote, textFromStreamEvents } from '../remote/rpc';
import { useRemoteTask } from '../context/RemoteTaskContext';
import { theme } from '../theme';

type Msg = { role: 'user' | 'assistant'; text: string };

/** 考点学习内的多轮追问 */
export function NodeFollowUpPanel({
  campaignId,
  nodeId,
  nodeName,
}: {
  campaignId: string;
  nodeId: string;
  nodeName: string;
}): React.JSX.Element {
  const { runTask, active } = useRemoteTask();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');

  const busy = active?.label === '追问';

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    const nextMessages = [...messages, { role: 'user' as const, text }];
    setMessages(nextMessages);
    const systemPrompt =
      `用户正在备考，当前学习的考点是「${nodeName}」（nodeId: ${nodeId}）。` +
      '请围绕该考点回答追问：澄清概念、对比易混点、补充面试深挖角度。' +
      '回答适合口述；必要时可用知识图谱工具查询或更新掌握度。';
    try {
      await runTask('追问', async () => {
        const chatMessages: ChatMessage[] = [
          { role: 'system', content: systemPrompt },
          ...nextMessages.map((m) => ({ role: m.role, content: m.text })),
        ];
        const { events } = await invokeRemote('llm:chat', {
          role: 'explain',
          messages: chatMessages,
          campaignId,
          allowWebSearch: true,
          sessionKind: 'nodeFollowUp',
        });
        const { text: reply } = textFromStreamEvents(events);
        setMessages((m) => [...m, { role: 'assistant', text: reply || '（无回复）' }]);
      });
    } catch (e) {
      setMessages((m) => [
        ...m,
        { role: 'assistant', text: `错误: ${e instanceof Error ? e.message : String(e)}` },
      ]);
    }
  };

  return (
    <View style={{ gap: 8, minHeight: 240 }}>
      <ScrollView style={{ maxHeight: 280 }} contentContainerStyle={{ gap: 10 }}>
        {messages.length === 0 ? (
          <Text style={{ color: theme.muted, fontSize: 12 }}>
            对「{nodeName}」有什么想追问的？可联网、可结合知识图谱
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
          onPress={() => void send()}
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
