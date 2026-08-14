import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { Repo } from '@shared/entities';
import { getRawDb } from '../db';
import { countRepoFiles } from '../data/repoFiles';
import { completeRepoAgentChat } from '../llm/agentChat';
import { runTask, useTaskResult, useTaskState } from '../context/RemoteTaskContext';
import { markdownToPlainText } from '../lib/markdownBlocks';
import { SourceBadge } from './SourceBadge';
import { useTheme } from '../theme';

export function ReadCodePanel({
  repo,
  onComplete,
}: {
  repo: Repo;
  onComplete?: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  // 按仓库记：导读要跑挺久，切页回来要能看到还在读，读完也要能看到结果
  const taskKey = `repo:readCode:${repo.id}`;
  const { running: busy, error } = useTaskState(taskKey);
  const [answer, setAnswer] = useState('');

  useTaskResult<string>(taskKey, setAnswer);

  const start = (): void => {
    if (busy || repo.status !== 'ready') return;
    setAnswer('');
    const synced = countRepoFiles(getRawDb(), repo.id);
    if (synced === 0) {
      setAnswer('该仓库尚无同步的源码文件，请在桌面端重新索引后全量同步。');
      return;
    }
    void runTask(
      taskKey,
      '读源码',
      () =>
        completeRepoAgentChat(getRawDb(), repo, [
          {
            role: 'user',
            content:
              '请引导我理解这个仓库：入口在哪、核心模块如何协作、有哪些值得面试时讲的设计点。' +
              '先用 list_dir 和 read_file 核实，再给出带来源行号的总结。',
          },
        ]),
      { toastSuccess: false },
    ).catch(() => undefined);
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
            onPress={start}
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
          {error !== null && <Text style={{ color: theme.danger, fontSize: 12 }}>{error}</Text>}
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
