import { useCallback, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { buildNodeFollowUpSystemPrompt } from '@shared/prompts/followUp';
import {
  buildFollowUpSummaryPrompt,
  compactFollowUpContext,
} from '@shared/llm/followUpContext';
import { completeChat } from '../llm/chat';
import {
  clearTaskError,
  runTask,
  useTaskResult,
  useTaskState,
} from '../context/RemoteTaskContext';
import { getRawDb } from '../db';
import {
  appendFollowUpMessage,
  deleteFollowUpHistory,
  migrateLegacyFollowUpHistory,
  updateFollowUpSummary,
  type FollowUpMessage,
} from '../data/mutations';
import { getNodeFollowUpContext, getNodeFollowUpHistory } from '../data/queries';
import { useLocalDataReload } from '../hooks/useLocalDataReload';
import { useTheme } from '../theme';

type Msg = FollowUpMessage;

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
  const theme = useTheme();
  // 按考点记这轮追问：切页、换 Tab 再回来还能看到「回答中…」和已经答完的内容
  const taskKey = `node:followUp:${nodeId}`;
  const { running: busy, error } = useTaskState(taskKey);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [clearing, setClearing] = useState(false);

  const reloadHistory = useCallback(() => {
    const db = getRawDb();
    void migrateLegacyFollowUpHistory(db, campaignId, nodeId, nodeName).then(() => {
      setMessages(getNodeFollowUpHistory(db, nodeId));
    });
  }, [campaignId, nodeId, nodeName]);
  useLocalDataReload(reloadHistory);

  // 任务返回整段对话，重新挂载后一次补齐提问与回答
  useTaskResult<Msg[]>(taskKey, (result) => {
    setMessages(result);
  });

  const send = (): void => {
    const text = input.trim();
    if (!text || busy || clearing) return;
    setInput('');
    const nextMessages = [...messages, { role: 'user' as const, text }];
    setMessages(nextMessages);
    const systemPrompt = buildNodeFollowUpSystemPrompt(nodeName, nodeId);
    void runTask(
      taskKey,
      '追问',
      async () => {
        await appendFollowUpMessage(getRawDb(), campaignId, nodeId, nodeName, {
          role: 'user',
          text,
        });
        const db = getRawDb();
        const context = getNodeFollowUpContext(db, nodeId);
        const compacted = await compactFollowUpContext({
          systemPrompt,
          messages: context.messages,
          state: context.state,
          summarize: (previousSummary, olderMessages) =>
            completeChat('explain', buildFollowUpSummaryPrompt(previousSummary, olderMessages)),
          saveSummary: (update) => updateFollowUpSummary(db, context.sessionId, update),
        });
        const reply = await completeChat('explain', compacted.messages);
        const assistant = { role: 'assistant' as const, text: reply || '（无回复）' };
        await appendFollowUpMessage(getRawDb(), campaignId, nodeId, nodeName, assistant);
        return [...nextMessages, assistant];
      },
      { toastSuccess: false },
    ).catch(() => undefined);
  };

  const clearHistory = (): void => {
    if (busy || clearing) return;
    setClearing(true);
    setMessages([]);
    setInput('');
    void deleteFollowUpHistory(getRawDb(), nodeId).finally(() => setClearing(false));
    clearTaskError(taskKey);
  };

  return (
    <View style={{ gap: 8, minHeight: 240 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ color: theme.muted, fontSize: 11 }}>当前考点的追问历史</Text>
        {(messages.length > 0 || error !== null) && (
          <Pressable onPress={clearHistory} disabled={busy || clearing} hitSlop={8}>
            <Text style={{ color: busy || clearing ? theme.muted : theme.danger, fontSize: 11 }}>
              清除历史
            </Text>
          </Pressable>
        )}
      </View>
      <ScrollView style={{ maxHeight: 280 }} contentContainerStyle={{ gap: 10 }}>
        {messages.length === 0 ? (
          <Text style={{ color: theme.muted, fontSize: 12 }}>
            对「{nodeName}」有什么想追问的？可以连续多轮对话，我会记住前面聊过的内容。
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
          disabled={busy || clearing || !input.trim()}
          style={{
            backgroundColor: theme.accent,
            paddingHorizontal: 14,
            justifyContent: 'center',
            borderRadius: 8,
            opacity: busy || clearing || !input.trim() ? 0.6 : 1,
          }}
        >
          <Text style={{ color: '#fff' }}>{busy ? '…' : '发送'}</Text>
        </Pressable>
      </View>
    </View>
  );
}
