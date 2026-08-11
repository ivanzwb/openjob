import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { ChatMessage } from '@shared/ipc';
import type { EvidenceKind } from '@shared/enums';
import type { Repo } from '@shared/entities';
import { invokeRemote, streamResultFromEvents } from '../remote/rpc';
import { useRemoteTask } from '../context/RemoteTaskContext';
import { markdownToPlainText } from '../lib/markdownBlocks';
import { SourceBadge } from './SourceBadge';
import { theme } from '../theme';

export function RepoQaPanel({ repo }: { repo: Repo }): React.JSX.Element {
  const { runTask, active } = useRemoteTask();
  const [input, setInput] = useState('');
  const [answer, setAnswer] = useState('');
  const [evidenceKind, setEvidenceKind] = useState<EvidenceKind>('model');
  const [allowWebSearch, setAllowWebSearch] = useState(true);
  const busy = active?.label === '源码问答';

  const submit = async (): Promise<void> => {
    const text = input.trim();
    if (!text || busy || repo.status !== 'ready') return;
    setInput('');
    setAnswer('');
    try {
      await runTask('源码问答', async () => {
        const messages: ChatMessage[] = [{ role: 'user', content: text }];
        const { events } = await invokeRemote('llm:chat', {
          role: 'codeAgent',
          repoId: repo.id,
          allowWebSearch,
          messages,
        });
        const result = streamResultFromEvents(events);
        if (result.error) throw new Error(result.error);
        setEvidenceKind(result.evidenceKind);
        setAnswer(result.text);
      }, { toastSuccess: false });
    } catch {
      // toast handled by runTask
    }
  };

  const displayText = answer.trim() ? markdownToPlainText(answer) : '';

  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: theme.text, fontWeight: '600', fontSize: 13 }}>源码问答</Text>
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
            contentContainerStyle={{ padding: 12, gap: 6 }}
          >
            {busy && !displayText ? (
              <>
                <SourceBadge kind={evidenceKind} />
                <Text style={{ color: theme.muted, fontSize: 12 }}>正在检索代码并生成回答…</Text>
              </>
            ) : displayText ? (
              <>
                <SourceBadge kind={evidenceKind} />
                <Text style={{ color: theme.text, fontSize: 13, lineHeight: 20 }}>{displayText}</Text>
              </>
            ) : (
              <Text style={{ color: theme.muted, fontSize: 12 }}>
                问启动流程、核心模块、关键数据结构… 回答会带 path:line 引用。
              </Text>
            )}
          </ScrollView>

          <Pressable onPress={() => setAllowWebSearch((v) => !v)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View
              style={{
                width: 18,
                height: 18,
                borderRadius: 4,
                borderWidth: 1,
                borderColor: theme.border,
                backgroundColor: allowWebSearch ? theme.accent : 'transparent',
              }}
            />
            <Text style={{ color: theme.muted, fontSize: 12 }}>允许联网（查设计意图）</Text>
          </Pressable>

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
