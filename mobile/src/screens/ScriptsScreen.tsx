import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { SpeechSnippetView } from '@shared/ipc';
import { getRawDb } from '../db';
import { listSpeechSnippets } from '../data/queries';
import { deleteSpeech, updateSpeech } from '../data/mutations';
import { useApp } from '../context/AppContext';
import { useRemoteTask } from '../context/RemoteTaskContext';
import { theme } from '../theme';

export function ScriptsScreen(): React.JSX.Element {
  const { triggerSync } = useApp();
  const { runTask } = useRemoteTask();
  const [items, setItems] = useState<SpeechSnippetView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const reload = useCallback(() => {
    const list = listSpeechSnippets(getRawDb());
    setItems(list);
    setSelectedId((prev) => {
      if (prev && list.some((s) => s.id === prev)) return prev;
      return list[0]?.id ?? null;
    });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!selectedId) {
      setDraft('');
      return;
    }
    const item = items.find((s) => s.id === selectedId);
    setDraft(item?.contentMd ?? '');
  }, [selectedId, items]);

  const selected = items.find((s) => s.id === selectedId) ?? null;
  const dirty = Boolean(selected && draft !== selected.contentMd);

  const save = async (): Promise<void> => {
    if (!selected || !dirty) return;
    try {
      await runTask('保存话术', async () => {
        await updateSpeech(getRawDb(), selected.id, draft);
        await triggerSync();
        reload();
        return '话术已保存';
      });
    } catch {
      // toast handled by runTask
    }
  };

  const remove = (): void => {
    if (!selected) return;
    Alert.alert('删除话术', '确定删除这条话术？', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              await runTask('删除话术', async () => {
                await deleteSpeech(getRawDb(), selected.id);
                await triggerSync();
                reload();
                return '已删除';
              });
            } catch {
              // toast handled by runTask
            }
          })();
        },
      },
    ]);
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.bg }}
      contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 32 }}
    >
      <Text style={{ color: theme.muted, fontSize: 12, lineHeight: 18 }}>
        考点讲解、考我反馈、源码问答的口语素材汇总。改写成你自己的话再背。导出 Markdown / Anki / PDF 请用桌面端。
      </Text>

      {items.length === 0 ? (
        <Text style={{ color: theme.muted, fontSize: 13 }}>
          还没有话术，完成考我或源码问答后可沉淀
        </Text>
      ) : (
        <>
          <View style={{ gap: 8 }}>
            {items.map((s) => (
              <Pressable
                key={s.id}
                onPress={() => setSelectedId(s.id)}
                style={{
                  borderWidth: 1,
                  borderColor: selectedId === s.id ? theme.accent : theme.border,
                  borderRadius: 8,
                  padding: 12,
                  backgroundColor: selectedId === s.id ? `${theme.accent}18` : theme.surface,
                  gap: 4,
                }}
              >
                <Text style={{ color: theme.text, fontSize: 13, fontWeight: '600' }} numberOfLines={1}>
                  {s.sourceLabel}
                </Text>
                <Text style={{ color: theme.muted, fontSize: 11, lineHeight: 16 }} numberOfLines={2}>
                  {s.contentMd.slice(0, 80)}
                </Text>
                {s.isUserEdited && (
                  <Text style={{ color: theme.accent, fontSize: 10 }}>已改写</Text>
                )}
              </Pressable>
            ))}
          </View>

          {selected ? (
            <View style={{ gap: 10, marginTop: 4 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <Text style={{ color: theme.text, fontSize: 14, fontWeight: '600', flex: 1 }} numberOfLines={2}>
                  {selected.sourceLabel}
                </Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Pressable onPress={remove}>
                    <Text style={{ color: theme.danger, fontSize: 12 }}>删除</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void save()}
                    disabled={!dirty}
                    style={{
                      backgroundColor: theme.accent,
                      paddingHorizontal: 12,
                      paddingVertical: 6,
                      borderRadius: 8,
                      opacity: dirty ? 1 : 0.4,
                    }}
                  >
                    <Text style={{ color: '#fff', fontSize: 12 }}>
                      {selected.isUserEdited ? '保存修改' : '保存为自己的话'}
                    </Text>
                  </Pressable>
                </View>
              </View>

              <TextInput
                multiline
                value={draft}
                onChangeText={setDraft}
                placeholder="改写成你自己的话…"
                placeholderTextColor={theme.muted}
                style={{
                  minHeight: 220,
                  color: theme.text,
                  borderWidth: 1,
                  borderColor: theme.border,
                  borderRadius: 8,
                  padding: 12,
                  fontSize: 13,
                  lineHeight: 20,
                  textAlignVertical: 'top',
                  backgroundColor: theme.surface,
                }}
              />
            </View>
          ) : (
            <Text style={{ color: theme.muted, fontSize: 13 }}>选择一条话术编辑</Text>
          )}
        </>
      )}
    </ScrollView>
  );
}
