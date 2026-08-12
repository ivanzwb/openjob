import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { Repo } from '@shared/entities';
import { getRawDb } from '../db';
import { countRepoFiles } from '../data/repoFiles';
import { completeRepoAgentChat } from '../llm/agentChat';
import { useRemoteTask } from '../context/RemoteTaskContext';
import { markdownToPlainText } from '../lib/markdownBlocks';
import { SourceBadge } from './SourceBadge';
import { theme } from '../theme';

export function RepoQaPanel({ repo }: { repo: Repo }): React.JSX.Element {
  const { runTask, active } = useRemoteTask();
  const [input, setInput] = useState('');
  const [answer, setAnswer] = useState('');
  const busy = active?.label === '源码问答';
  const syncedFiles = countRepoFiles(getRawDb(), repo.id);

  const submit = async (): Promise<void> => {
    const text = input.trim();
    if (!text || busy || repo.status !== 'ready') return;
    if (syncedFiles === 0) {
      setAnswer('该仓库尚无同步的源码文件，请在桌面端重新索引后全量同步。');
      return;
    }
    setInput('');
    setAnswer('');
    try {
      await runTask(
        '源码问答',
        async () => {
          const reply = await completeRepoAgentChat(getRawDb(), repo, [
            { role: 'user', content: text },
          ]);
          setAnswer(reply);
        },
        { toastSuccess: false },
      );
    } catch {
      // toast handled by runTask
    }
  };

  const displayText = answer.trim() ? markdownToPlainText(answer) : '';

  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: theme.text, fontWeight: '600', fontSize: 13 }}>源码问答</Text>
      <Text style={{ color: theme.muted, fontSize: 11 }}>
        已同步 {syncedFiles} 个文件，Agent 可 list_dir / read_file / grep 读源码。
      </Text>
      {repo.status !== 'ready' ? (
        <Text style={{ color: theme.muted, fontSize: 12 }}>仓库索引中，完成后可开始问答…</Text>
      ) : (
        <>
          <ScrollView
            style={{
              maxHeight: 280,
              borderWidth: 1,
              borderColor: theme.border,
              borderRadius: 8,
              backgroundColor: theme.surface,
            }}
            contentContainerStyle={{ padding: 12, gap: 4 }}
          >
            {busy && !displayText ? (
              <>
                <SourceBadge kind="model" />
                <Text style={{ color: theme.muted, fontSize: 12 }}>正在生成回答…</Text>
              </>
            ) : displayText ? (
              <>
                <SourceBadge kind="model" />
                <Text style={{ color: theme.text, fontSize: 13, lineHeight: 20 }}>{displayText}</Text>
              </>
            ) : (
              <Text style={{ color: theme.muted, fontSize: 12 }}>
                问启动流程、核心模块、目录结构… Agent 会读已同步的源码回答。
              </Text>
            )}
          </ScrollView>

          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder="例如：主流程是怎么启动的？"
              placeholderTextColor={theme.muted}
              editable={!busy}
              style={{
                flex: 1,
                color: theme.text,
                borderWidth: 1,
                borderColor: theme.border,
                borderRadius: 8,
                paddingHorizontal: 10,
                paddingVertical: 8,
                fontSize: 13,
              }}
            />
            <Pressable
              onPress={() => void submit()}
              disabled={busy || !input.trim()}
              style={{
                backgroundColor: theme.accent,
                paddingHorizontal: 14,
                justifyContent: 'center',
                borderRadius: 8,
                opacity: busy || !input.trim() ? 0.5 : 1,
              }}
            >
              <Text style={{ color: '#fff', fontSize: 12 }}>发送</Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}
