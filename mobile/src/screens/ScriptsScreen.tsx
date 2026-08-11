import { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { SpeechSnippetView } from '@shared/ipc';
import { getRawDb } from '../db';
import { listSpeechSnippets } from '../data/queries';
import { deleteSpeech, updateSpeech } from '../data/mutations';
import { useApp } from '../context/AppContext';
import { useRemoteTask } from '../context/RemoteTaskContext';
import { useLocalDataReload } from '../hooks/useLocalDataReload';
import { markdownToPlainText } from '../lib/markdownBlocks';
import { theme } from '../theme';

type PanelMode = 'preview' | 'edit';

const TIER_LABEL: Record<SpeechSnippetView['tier'], string> = {
  oneliner: '一句话',
  spoken: '口语稿',
  deep: '深挖',
};

function selectSnippet(s: SpeechSnippetView): { id: string; draft: string; mode: PanelMode } {
  return { id: s.id, draft: s.contentMd, mode: 'preview' };
}

export function ScriptsScreen(): React.JSX.Element {
  const { triggerSync } = useApp();
  const { runTask } = useRemoteTask();
  const [items, setItems] = useState<SpeechSnippetView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelMode, setPanelMode] = useState<PanelMode>('preview');
  const [draft, setDraft] = useState('');

  const reload = useCallback(() => {
    const list = listSpeechSnippets(getRawDb());
    setItems(list);
    setSelectedId((prev) => {
      if (prev) {
        const kept = list.find((s) => s.id === prev);
        if (kept) {
          setDraft(kept.contentMd);
          return prev;
        }
      }
      if (list[0]) {
        setDraft(list[0].contentMd);
        setPanelMode('preview');
        return list[0].id;
      }
      setDraft('');
      setPanelMode('preview');
      return null;
    });
  }, []);

  useLocalDataReload(reload);

  const selected = items.find((s) => s.id === selectedId) ?? null;
  const dirty = Boolean(selected && draft !== selected.contentMd);

  const pick = (s: SpeechSnippetView): void => {
    const next = selectSnippet(s);
    setSelectedId(next.id);
    setDraft(next.draft);
    setPanelMode(next.mode);
  };

  const save = async (): Promise<void> => {
    if (!selected || !dirty) return;
    try {
      await runTask('保存话术', async () => {
        await updateSpeech(getRawDb(), selected.id, draft);
        await triggerSync();
        reload();
        setPanelMode('preview');
        return '话术已保存';
      });
    } catch {
      // toast handled by runTask
    }
  };

  const remove = (snippet: SpeechSnippetView): void => {
    Alert.alert('删除话术', `确定删除「${snippet.sourceLabel}」？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              await runTask('删除话术', async () => {
                await deleteSpeech(getRawDb(), snippet.id);
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
      keyboardShouldPersistTaps="handled"
    >
      <Text style={{ color: theme.muted, fontSize: 12, lineHeight: 18 }}>
        考点讲解、考我反馈、源码问答的口语素材汇总。可预览全文、改写成你自己的话再背。导出请用桌面端。
      </Text>

      {items.length === 0 ? (
        <Text style={{ color: theme.muted, fontSize: 13 }}>
          还没有话术，完成考我或源码问答后可沉淀
        </Text>
      ) : (
        <>
          <Text style={{ color: theme.muted, fontSize: 11 }}>共 {items.length} 条</Text>

          <View style={{ gap: 8 }}>
            {items.map((s) => (
              <View
                key={s.id}
                style={{
                  flexDirection: 'row',
                  alignItems: 'stretch',
                  gap: 8,
                }}
              >
                <Pressable
                  onPress={() => pick(s)}
                  style={{
                    flex: 1,
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
                  <Text style={{ color: theme.muted, fontSize: 10 }}>
                    {TIER_LABEL[s.tier]}
                    {s.isUserEdited ? ' · 已改写' : ''}
                  </Text>
                  <Text style={{ color: theme.muted, fontSize: 11, lineHeight: 16 }} numberOfLines={3}>
                    {markdownToPlainText(s.contentMd)}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => remove(s)}
                  style={{
                    justifyContent: 'center',
                    paddingHorizontal: 10,
                    borderWidth: 1,
                    borderColor: theme.border,
                    borderRadius: 8,
                    backgroundColor: theme.surface,
                  }}
                >
                  <Text style={{ color: theme.danger, fontSize: 11 }}>删除</Text>
                </Pressable>
              </View>
            ))}
          </View>

          {selected ? (
            <View style={{ gap: 10, marginTop: 4 }}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {(['preview', 'edit'] as const).map((mode) => (
                  <Pressable
                    key={mode}
                    onPress={() => {
                      if (mode === 'preview' && dirty) {
                        Alert.alert('未保存的修改', '切换预览将放弃未保存的编辑，是否继续？', [
                          { text: '取消', style: 'cancel' },
                          {
                            text: '放弃修改',
                            style: 'destructive',
                            onPress: () => {
                              setDraft(selected.contentMd);
                              setPanelMode('preview');
                            },
                          },
                        ]);
                        return;
                      }
                      setPanelMode(mode);
                    }}
                    style={{
                      paddingHorizontal: 10,
                      paddingVertical: 5,
                      borderRadius: 8,
                      backgroundColor: panelMode === mode ? theme.accent : theme.bg,
                      borderWidth: panelMode === mode ? 0 : 1,
                      borderColor: theme.border,
                    }}
                  >
                    <Text style={{ color: panelMode === mode ? '#fff' : theme.muted, fontSize: 12 }}>
                      {mode === 'preview' ? '预览' : '编辑'}
                    </Text>
                  </Pressable>
                ))}
              </View>

              <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ color: theme.text, fontSize: 14, fontWeight: '600' }}>{selected.sourceLabel}</Text>
                  <Text style={{ color: theme.muted, fontSize: 11 }}>
                    {TIER_LABEL[selected.tier]}
                    {selected.isUserEdited ? ' · 已改写' : ''}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Pressable onPress={() => remove(selected)}>
                    <Text style={{ color: theme.danger, fontSize: 12 }}>删除</Text>
                  </Pressable>
                  {panelMode === 'edit' && (
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
                  )}
                </View>
              </View>

              {panelMode === 'preview' ? (
                <ScrollView
                  style={{
                    maxHeight: 360,
                    borderWidth: 1,
                    borderColor: theme.border,
                    borderRadius: 8,
                    backgroundColor: theme.surface,
                  }}
                  contentContainerStyle={{ padding: 12 }}
                  nestedScrollEnabled
                >
                  <Text style={{ color: theme.text, fontSize: 13, lineHeight: 22 }}>
                    {markdownToPlainText(selected.contentMd) || '（空）'}
                  </Text>
                </ScrollView>
              ) : (
                <TextInput
                  multiline
                  value={draft}
                  onChangeText={setDraft}
                  placeholder="改写成你自己的话…"
                  placeholderTextColor={theme.muted}
                  style={{
                    minHeight: 280,
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
              )}
            </View>
          ) : (
            <Text style={{ color: theme.muted, fontSize: 13 }}>选择一条话术预览或编辑</Text>
          )}
        </>
      )}
    </ScrollView>
  );
}
