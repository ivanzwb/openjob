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

export function ReadCodePanel({
  repo,
  onComplete,
}: {
  repo: Repo;
  onComplete?: () => void;
}): React.JSX.Element {
  const { runTask, active } = useRemoteTask();
  const [answer, setAnswer] = useState('');
  const busy = active?.label === '读源码';

  const start = async (): Promise<void> => {
    if (busy || repo.status !== 'ready') return;
    setAnswer('');
    const synced = countRepoFiles(getRawDb(), repo.id);
    if (synced === 0) {
      setAnswer('该仓库尚无同步的源码文件，请在桌面端重新索引后全量同步。');
      return;
    }
    try {
      await runTask(
        '读源码',
        async () => {
          const reply = await completeRepoAgentChat(getRawDb(), repo, [
            {
              role: 'user',
              content:
                '请引导我理解这个仓库：入口在哪、核心模块如何协作、有哪些值得面试时讲的设计点。' +
                '先用 list_dir 和 read_file 核实，再给出带来源行号的总结。',
            },
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
      <Text style={{ color: theme.text, fontWeight: '600', fontSize: 13 }}>读源码</Text>
      <Text style={{ color: theme.muted, fontSize: 11 }}>
        使用已同步的源码快照，Agent 可 list_dir / read_file / grep。
      </Text>
      {repo.status !== 'ready' ? (
        <Text style={{ color: theme.muted, fontSize: 12 }}>仓库索引中，完成后可开始…</Text>
      ) : (
        <>
          <Pressable
            onPress={() => void start()}
            disabled={busy}
            style={{
              backgroundColor: theme.accent,
              padding: 10,
              borderRadius: 8,
              alignItems: 'center',
              opacity: busy ? 0.6 : 1,
            }}
          >
            <Text style={{ color: '#fff' }}>{busy ? '分析中…' : '开始读源码'}</Text>
          </Pressable>
          {(busy || displayText) && (
            <ScrollView
              style={{
                maxHeight: 320,
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
                  <Text style={{ color: theme.muted, fontSize: 12 }}>正在阅读源码并生成导读…</Text>
                </>
              ) : (
                <>
                  <SourceBadge kind="model" />
                  <Text style={{ color: theme.text, fontSize: 13, lineHeight: 20 }}>{displayText}</Text>
                </>
              )}
            </ScrollView>
          )}
          {displayText && onComplete && (
            <Pressable onPress={onComplete} style={{ alignSelf: 'flex-start', padding: 6 }}>
              <Text style={{ color: theme.accent, fontSize: 12 }}>标记完成</Text>
            </Pressable>
          )}
        </>
      )}
    </View>
  );
}
