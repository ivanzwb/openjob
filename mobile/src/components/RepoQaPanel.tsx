import { useCallback, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import type { Repo } from '@shared/entities';
import { getRawDb } from '../db';
import { countRepoFiles } from '../data/repoFiles';
import { appendRepoQaMessage, deleteRepoQaHistory } from '../data/mutations';
import { getRepoQaHistory } from '../data/queries';
import { buildRepoQaThread, type RepoQaMessage } from '../data/repoQaThread';
import { completeRepoAgentChat } from '../llm/agentChat';
import { clearTaskError, runTask, useTaskResult, useTaskState } from '../context/RemoteTaskContext';
import { useLocalDataReload } from '../hooks/useLocalDataReload';
import { MarkdownPreview } from './MarkdownPreview';
import { SourceBadge } from './SourceBadge';
import { VoiceInputButton } from './VoiceInputButton';
import { useTheme } from '../theme';

function RepoQaBubble({ message }: { message: RepoQaMessage }): React.JSX.Element {
  const theme = useTheme();
  const isUser = message.role === 'user';

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
        <>
          <SourceBadge kind="model" />
          <MarkdownPreview text={message.text} />
        </>
      )}
    </View>
  );
}

export function RepoQaPanel({ repo }: { repo: Repo }): React.JSX.Element {
  const theme = useTheme();
  // 按仓库记这串问答：切页回来能接着看，答完也不会丢
  const taskKey = `repo:qa:${repo.id}`;
  const { running: busy, error } = useTaskState(taskKey);
  const [messages, setMessages] = useState<RepoQaMessage[]>([]);
  const [input, setInput] = useState('');
  const [clearing, setClearing] = useState(false);
  const [notice, setNotice] = useState('');
  const syncedFiles = countRepoFiles(getRawDb(), repo.id);

  const reloadHistory = useCallback(() => {
    setMessages(getRepoQaHistory(getRawDb(), repo.id));
  }, [repo.id]);
  useLocalDataReload(reloadHistory);

  useTaskResult<RepoQaMessage[]>(taskKey, setMessages);

  const submit = (): void => {
    const text = input.trim();
    if (!text || busy || clearing || repo.status !== 'ready') return;
    if (syncedFiles === 0) {
      setNotice('该仓库尚无同步的源码文件，请在桌面端重新索引后全量同步。');
      return;
    }
    setInput('');
    setNotice('');
    const history = messages;
    const nextMessages: RepoQaMessage[] = [...history, { role: 'user', text }];
    setMessages(nextMessages);
    void runTask(
      taskKey,
      '源码问答',
      async () => {
        // 两条消息都在任务里落库：切走 Tab 时结果仍会进历史，不只活在界面状态里
        await appendRepoQaMessage(getRawDb(), repo.id, repo.url, { role: 'user', text });
        const reply = await completeRepoAgentChat(
          getRawDb(),
          repo,
          buildRepoQaThread(history, text),
        );
        const assistant: RepoQaMessage = { role: 'assistant', text: reply || '（无回复）' };
        await appendRepoQaMessage(getRawDb(), repo.id, repo.url, assistant);
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
    setNotice('');
    void deleteRepoQaHistory(getRawDb(), repo.id).finally(() => setClearing(false));
    clearTaskError(taskKey);
  };

  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ color: theme.text, fontWeight: '600', fontSize: 13 }}>源码问答</Text>
        {(messages.length > 0 || error !== null) && (
          <Pressable onPress={clearHistory} disabled={busy || clearing} hitSlop={8}>
            <Text style={{ color: busy || clearing ? theme.muted : theme.danger, fontSize: 11 }}>
              清除历史
            </Text>
          </Pressable>
        )}
      </View>
      <Text style={{ color: theme.muted, fontSize: 11 }}>
        已同步 {syncedFiles} 个文件，Agent 可 list_dir / read_file / grep 读源码。
      </Text>
      {repo.status !== 'ready' ? (
        <Text style={{ color: theme.muted, fontSize: 12 }}>仓库索引中，完成后可开始问答…</Text>
      ) : (
        <>
          {/*
            问答内容直接铺在页面里，不套可滚动容器：嵌套滚动要和外层页面抢手势，
            表现就是长回答单指划不动。铺开后靠页面本身滚动就行，和考点追问一致。
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
                问启动流程、核心模块、目录结构… Agent 会读已同步的源码回答，可以连续追问。
              </Text>
            ) : (
              messages.map((m, i) => <RepoQaBubble key={i} message={m} />)
            )}
            {busy && <Text style={{ color: theme.muted, fontSize: 12 }}>正在生成回答…</Text>}
            {notice !== '' && (
              <Text style={{ color: theme.muted, fontSize: 12 }}>{notice}</Text>
            )}
            {error !== null && (
              <Text selectable style={{ color: theme.danger, fontSize: 12 }}>
                {error}
              </Text>
            )}
          </View>

          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder="例如：主流程是怎么启动的？"
              placeholderTextColor={theme.muted}
              editable={!busy && !clearing}
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
                fontSize: 13,
                textAlignVertical: 'top',
              }}
            />
            <VoiceInputButton
              onTranscript={(text) => setInput((prev) => (prev ? prev + text : text))}
              disabled={busy || clearing}
              prompt="代码仓库问题，源码与实现"
            />
            <Pressable
              onPress={submit}
              disabled={busy || clearing || !input.trim()}
              style={{
                backgroundColor: theme.accent,
                paddingHorizontal: 14,
                paddingVertical: 12,
                justifyContent: 'center',
                borderRadius: 8,
                opacity: busy || clearing || !input.trim() ? 0.5 : 1,
              }}
            >
              <Text style={{ color: '#fff', fontSize: 12 }}>{busy ? '回答中…' : '发送'}</Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}
