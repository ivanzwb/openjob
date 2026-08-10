import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { ChatMessage } from '@shared/ipc';
import { getRawDb } from '../db';
import { listCampaigns } from '../data/queries';
import { invokeRemote, textFromStreamEvents } from '../remote/rpc';
import { useRemoteTask } from '../context/RemoteTaskContext';
import { theme } from '../theme';

type Msg = { role: 'user' | 'assistant'; text: string };

/** 总览页的精简全局对话 */
export function GlobalChatPanel(): React.JSX.Element {
  const campaigns = listCampaigns(getRawDb());
  const { runTask, active } = useRemoteTask();
  const [campaignId, setCampaignId] = useState(campaigns[0]?.id ?? '');
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');

  const busy = active?.label === '助手';

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    const nextMessages = [...messages, { role: 'user' as const, text }];
    setMessages(nextMessages);
    try {
      await runTask('助手', async () => {
        const chatMessages: ChatMessage[] = nextMessages.map((m) => ({
          role: m.role,
          content: m.text,
        }));
        const { events } = await invokeRemote('llm:chat', {
          role: 'explain',
          messages: chatMessages,
          campaignId: campaignId || undefined,
          allowWebSearch: true,
          sessionKind: 'freeChat',
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
    <View
      style={{
        borderWidth: 1,
        borderColor: theme.border,
        borderRadius: 12,
        backgroundColor: theme.surface,
        overflow: 'hidden',
        minHeight: 280,
      }}
    >
      <Text style={{ color: theme.muted, fontSize: 11, padding: 10, paddingBottom: 0 }}>
        跨考点提问、查面经；单考点追问请在学习页使用
      </Text>
      {campaigns.length > 0 && (
        <ScrollView
          horizontal
          style={{ maxHeight: 44, borderBottomWidth: 1, borderColor: theme.border }}
          contentContainerStyle={{ padding: 8, gap: 8 }}
        >
          {campaigns.map((c) => (
            <Pressable
              key={c.id}
              onPress={() => setCampaignId(c.id)}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 16,
                backgroundColor: campaignId === c.id ? theme.accent : theme.bg,
              }}
            >
              <Text style={{ color: campaignId === c.id ? '#fff' : theme.text, fontSize: 11 }}>
                {c.company}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      <ScrollView style={{ maxHeight: 220, padding: 12 }} contentContainerStyle={{ gap: 10 }}>
        {messages.length === 0 ? (
          <Text style={{ color: theme.muted, fontSize: 12 }}>可联网检索，试试问时效性面经问题</Text>
        ) : (
          messages.map((m, i) => (
            <View
              key={i}
              style={{
                alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '85%',
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
      <View
        style={{
          flexDirection: 'row',
          padding: 10,
          gap: 8,
          borderTopWidth: 1,
          borderColor: theme.border,
        }}
      >
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="提问…"
          placeholderTextColor={theme.muted}
          style={{
            flex: 1,
            color: theme.text,
            borderWidth: 1,
            borderColor: theme.border,
            borderRadius: 8,
            paddingHorizontal: 10,
            paddingVertical: 8,
          }}
        />
        <Pressable
          onPress={() => void send()}
          style={{
            backgroundColor: theme.accent,
            paddingHorizontal: 16,
            justifyContent: 'center',
            borderRadius: 8,
            opacity: busy ? 0.6 : 1,
          }}
        >
          <Text style={{ color: '#fff' }}>{busy ? '…' : '发送'}</Text>
        </Pressable>
      </View>
    </View>
  );
}
