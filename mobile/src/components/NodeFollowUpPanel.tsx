import { useCallback, useState } from 'react';
import { Alert, Pressable, Text, TextInput, View } from 'react-native';
import type { ExplanationTier } from '@shared/enums';
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
import { buildNodeFollowUpSystem } from '../data/candidateContextLocal';
import {
  appendFollowUpMessage,
  deleteFollowUpHistory,
  migrateLegacyFollowUpHistory,
  saveSpeechFromNode,
  updateFollowUpSummary,
  type FollowUpMessage,
} from '../data/mutations';
import { getNodeFollowUpContext, getNodeFollowUpHistory } from '../data/queries';
import { useLocalDataReload } from '../hooks/useLocalDataReload';
import { useTheme } from '../theme';
import { MarkdownPreview } from './MarkdownPreview';
import { VoiceInputButton } from './VoiceInputButton';

type Msg = FollowUpMessage;

function FollowUpMessageBubble({
  message,
  tier,
  nodeId,
  onSavedSpeech,
}: {
  message: Msg;
  tier: ExplanationTier;
  nodeId: string;
  onSavedSpeech: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const isUser = message.role === 'user';

  const saveToSpeech = (): void => {
    const text = message.text.trim();
    if (!text) return;
    void saveSpeechFromNode(getRawDb(), nodeId, text, tier).then((saved) => {
      onSavedSpeech();
      Alert.alert('话术库', saved.existing ? '这段已经在话术库里' : '已加入话术库');
    });
  };

  return (
    <View
      style={{
        alignSelf: isUser ? 'flex-end' : 'stretch',
        maxWidth: isUser ? '92%' : '100%',
        width: isUser ? undefined : '100%',
        backgroundColor: isUser ? theme.accent : theme.bg,
        padding: 10,
        borderRadius: 10,
        borderWidth: isUser ? 0 : 1,
        borderColor: theme.border,
        gap: 6,
      }}
    >
      {isUser ? (
        <Text selectable style={{ color: '#fff', fontSize: 13, lineHeight: 20 }}>
          {message.text}
        </Text>
      ) : (
        <MarkdownPreview text={message.text} />
      )}
      {!isUser && (
        <Pressable onPress={saveToSpeech} hitSlop={8}>
          <Text style={{ color: theme.accent, fontSize: 11 }}>加入话术库</Text>
        </Pressable>
      )}
    </View>
  );
}

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

  useTaskResult<Msg[]>(taskKey, (result) => {
    setMessages(result);
  });

  const send = (): void => {
    const text = input.trim();
    if (!text || busy || clearing) return;
    setInput('');
    const nextMessages = [...messages, { role: 'user' as const, text }];
    setMessages(nextMessages);
    void runTask(
      taskKey,
      '追问',
      async () => {
        await appendFollowUpMessage(getRawDb(), campaignId, nodeId, nodeName, {
          role: 'user',
          text,
        });
        const db = getRawDb();
        // 简历/JD 要查库才有，所以 system 在这里拼而不是渲染时拼
        const systemPrompt = buildNodeFollowUpSystem(db, nodeId, nodeName);
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
    <View style={{ gap: 8, minHeight: 320 }}>
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
      {/*
        追问内容直接铺在页面里，不再套一层可滚动容器：嵌套滚动要和外层页面抢手势，
        表现就是单指划不动、得另一根手指先按住别处。铺开后长回答靠页面本身滚动就行。
      */}
      <View
        style={{
          gap: 10,
          padding: 10,
          borderWidth: 1,
          borderColor: theme.border,
          borderRadius: 10,
        }}
      >
        {messages.length === 0 ? (
          <Text style={{ color: theme.muted, fontSize: 12 }}>
            对「{nodeName}」有什么想追问的？可以连续多轮对话，我会记住前面聊过的内容。
          </Text>
        ) : (
          messages.map((m, i) => (
            <FollowUpMessageBubble
              key={i}
              message={m}
              nodeId={nodeId}
              tier="spoken"
              onSavedSpeech={() => undefined}
            />
          ))
        )}
        {busy && <Text style={{ color: theme.muted, fontSize: 12 }}>回答中…</Text>}
        {error !== null && <Text style={{ color: theme.danger, fontSize: 12 }}>{error}</Text>}
      </View>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder={`追问「${nodeName}」…`}
          placeholderTextColor={theme.muted}
          multiline
          style={{
            flex: 1,
            minHeight: 44,
            maxHeight: 120,
            color: theme.text,
            borderWidth: 1,
            borderColor: theme.border,
            borderRadius: 8,
            paddingHorizontal: 10,
            paddingVertical: 8,
            textAlignVertical: 'top',
          }}
        />
        <VoiceInputButton
          disabled={busy || clearing}
          onTranscript={(text) => setInput((prev) => (prev ? `${prev}${text}` : text))}
          prompt="面试追问回答，技术细节与原理"
        />
        <Pressable
          onPress={send}
          disabled={busy || clearing || !input.trim()}
          style={{
            backgroundColor: theme.accent,
            paddingHorizontal: 14,
            paddingVertical: 12,
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
