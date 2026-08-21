import { useCallback, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { SpeechSnippetView } from '@shared/ipc';
import { getRawDb } from '../db';
import { listSpeechSnippets } from '../data/queries';
import { deleteSpeech, updateSpeech } from '../data/mutations';
import { useApp } from '../context/AppContext';
import { runTask, useTaskResult, useTaskState } from '../context/RemoteTaskContext';
import { useLocalDataReload } from '../hooks/useLocalDataReload';
import { markdownToPlainText } from '../lib/markdownBlocks';
import { SpeechLibraryPreviewModal } from '../components/SpeechLibraryPreviewModal';
import { useTheme } from '../theme';

type PanelMode = 'preview' | 'edit';

const TIER_LABEL: Record<SpeechSnippetView['tier'], string> = {
  oneliner: '一句话',
  spoken: '口语稿',
  deep: '深挖',
};

function selectSnippet(s: SpeechSnippetView): { id: string; draft: string; mode: PanelMode } {
  return { id: s.id, draft: s.contentMd, mode: 'preview' };
}

/** 列表里的删除按钮：每条各自跟着自己的删除任务，关掉弹窗再打开也还在删 */
function SnippetDeleteButton({
  snippetId,
  onPress,
}: {
  snippetId: string;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const { running } = useTaskState(`speech:delete:${snippetId}`);
  return (
    <Pressable
      onPress={onPress}
      disabled={running}
      style={{
        justifyContent: 'center',
        paddingHorizontal: 10,
        borderWidth: 1,
        borderColor: theme.border,
        borderRadius: 8,
        backgroundColor: theme.bg,
        opacity: running ? 0.5 : 1,
      }}
    >
      <Text style={{ color: theme.danger, fontSize: 11 }}>{running ? '删除中…' : '删除'}</Text>
    </Pressable>
  );
}

export function ScriptsScreen(): React.JSX.Element {
  const theme = useTheme();
  const { triggerSync, notifyDataChanged } = useApp();
  const [items, setItems] = useState<SpeechSnippetView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelMode, setPanelMode] = useState<PanelMode>('preview');
  const [draft, setDraft] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [overallPreviewOpen, setOverallPreviewOpen] = useState(false);

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

  const saveKey = selected ? `speech:save:${selected.id}` : 'speech:save:none';
  const { running: saving } = useTaskState(saveKey);
  const { running: removingSelected } = useTaskState(
    selected ? `speech:delete:${selected.id}` : 'speech:delete:none',
  );

  // 保存成功后切回预览；这一步即使保存跑完时页面被重建也不会丢
  useTaskResult(saveKey, () => setPanelMode('preview'));

  const save = (): void => {
    if (!selected || !dirty || saving) return;
    const target = { id: selected.id, contentMd: draft };
    void runTask(saveKey, '保存话术', async () => {
      await updateSpeech(getRawDb(), target.id, target.contentMd);
      notifyDataChanged();
      await triggerSync().catch(() => undefined);
      return '话术已保存';
    }).catch(() => undefined);
  };

  const remove = (snippet: SpeechSnippetView): void => {
    Alert.alert('删除话术', `确定删除「${snippet.sourceLabel}」？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          void runTask(`speech:delete:${snippet.id}`, '删除话术', async () => {
            await deleteSpeech(getRawDb(), snippet.id);
            notifyDataChanged();
            await triggerSync().catch(() => undefined);
            return '已删除';
          }).catch(() => undefined);
        },
      },
    ]);
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, padding: 16, gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
        <Text style={{ flex: 1, color: theme.muted, fontSize: 12, lineHeight: 18 }}>
          考点讲解、考我反馈、源码问答的口语素材汇总。可预览全文、改写成你自己的话再背。
        </Text>
        <Pressable
          onPress={() => setOverallPreviewOpen(true)}
          disabled={items.length === 0}
          style={{
            borderWidth: 1,
            borderColor: theme.border,
            borderRadius: 8,
            backgroundColor: theme.surface,
            paddingHorizontal: 10,
            paddingVertical: 7,
            opacity: items.length === 0 ? 0.5 : 1,
          }}
        >
          <Text style={{ color: theme.accent, fontSize: 12 }}>整体预览/打印</Text>
        </Pressable>
      </View>

      {items.length === 0 ? (
        <Text style={{ color: theme.muted, fontSize: 13 }}>
          还没有话术，完成考我或源码问答后可沉淀
        </Text>
      ) : (
        <>
          {/* 话术下拉选择器：列表折叠为一行，正文获得全部剩余空间 */}
          <Pressable
            onPress={() => setPickerOpen(true)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              borderWidth: 1,
              borderColor: theme.border,
              borderRadius: 8,
              backgroundColor: theme.surface,
              paddingHorizontal: 12,
              paddingVertical: 10,
            }}
          >
            <Text style={{ flex: 1, color: theme.text, fontSize: 13, fontWeight: '600' }} numberOfLines={1}>
              {selected ? selected.sourceLabel : '选择一条话术'}
            </Text>
            <Text style={{ color: theme.muted, fontSize: 11 }}>共 {items.length} 条</Text>
            <Text style={{ color: theme.muted, fontSize: 12 }}>▾</Text>
          </Pressable>

          {selected ? (
            <>
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
                  <Pressable onPress={() => remove(selected)} disabled={removingSelected}>
                    <Text style={{ color: theme.danger, fontSize: 12, opacity: removingSelected ? 0.5 : 1 }}>
                      {removingSelected ? '删除中…' : '删除'}
                    </Text>
                  </Pressable>
                  {panelMode === 'edit' && (
                    <Pressable
                      onPress={save}
                      disabled={!dirty || saving}
                      style={{
                        backgroundColor: theme.accent,
                        paddingHorizontal: 12,
                        paddingVertical: 6,
                        borderRadius: 8,
                        opacity: dirty && !saving ? 1 : 0.4,
                      }}
                    >
                      <Text style={{ color: '#fff', fontSize: 12 }}>
                        {saving ? '保存中…' : selected.isUserEdited ? '保存修改' : '保存为自己的话'}
                      </Text>
                    </Pressable>
                  )}
                </View>
              </View>

              {panelMode === 'preview' ? (
                <ScrollView
                  style={{
                    flex: 1,
                    borderWidth: 1,
                    borderColor: theme.border,
                    borderRadius: 8,
                    backgroundColor: theme.surface,
                  }}
                  contentContainerStyle={{ padding: 12 }}
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
                    flex: 1,
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
            </>
          ) : (
            <Text style={{ color: theme.muted, fontSize: 13 }}>选择一条话术预览或编辑</Text>
          )}
        </>
      )}

      {/* 话术下拉列表 */}
      <Modal visible={pickerOpen} transparent animationType="fade" onRequestClose={() => setPickerOpen(false)}>
        <View style={{ flex: 1, justifyContent: 'center', padding: 16 }}>
          <Pressable
            style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: theme.scrim }}
            onPress={() => setPickerOpen(false)}
          />
          <View
            style={{
              maxHeight: '85%',
              borderRadius: 12,
              borderWidth: 1,
              borderColor: theme.border,
              backgroundColor: theme.surface,
              padding: 14,
              gap: 10,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={{ color: theme.text, fontWeight: '600', fontSize: 15 }}>话术列表</Text>
              <Text style={{ color: theme.muted, fontSize: 11 }}>共 {items.length} 条</Text>
            </View>

            <ScrollView style={{ maxHeight: 420 }} keyboardShouldPersistTaps="handled">
              <View style={{ gap: 8 }}>
                {items.map((s) => (
                  <View key={s.id} style={{ flexDirection: 'row', alignItems: 'stretch', gap: 8 }}>
                    <Pressable
                      onPress={() => {
                        pick(s);
                        setPickerOpen(false);
                      }}
                      style={{
                        flex: 1,
                        borderWidth: 1,
                        borderColor: selectedId === s.id ? theme.accent : theme.border,
                        borderRadius: 8,
                        padding: 10,
                        backgroundColor: selectedId === s.id ? `${theme.accent}18` : theme.bg,
                        gap: 3,
                      }}
                    >
                      <Text style={{ color: theme.text, fontSize: 13, fontWeight: '600' }} numberOfLines={1}>
                        {s.sourceLabel}
                      </Text>
                      <Text style={{ color: theme.muted, fontSize: 10 }}>
                        {TIER_LABEL[s.tier]}
                        {s.isUserEdited ? ' · 已改写' : ''}
                      </Text>
                      <Text style={{ color: theme.muted, fontSize: 11, lineHeight: 16 }} numberOfLines={2}>
                        {markdownToPlainText(s.contentMd)}
                      </Text>
                    </Pressable>
                    <SnippetDeleteButton snippetId={s.id} onPress={() => remove(s)} />
                  </View>
                ))}
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
      {overallPreviewOpen && (
        <SpeechLibraryPreviewModal items={items} onClose={() => setOverallPreviewOpen(false)} />
      )}
    </View>
  );
}