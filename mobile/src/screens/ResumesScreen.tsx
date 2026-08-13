import { useCallback, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { getRawDb } from '../db';
import {
  createResumeFromText,
  deleteResumeEntry,
  listResumeEntries,
  type ResumeEntry,
} from '../data/resumeLocal';
import { useApp } from '../context/AppContext';
import { useRemoteTask } from '../context/RemoteTaskContext';
import { useLocalDataReload } from '../hooks/useLocalDataReload';
import { ResumeEditor } from '../components/ResumeEditor';
import { theme } from '../theme';

function entryKey(entry: ResumeEntry): string {
  return `${entry.kind}:${entry.id}`;
}

export function ResumesScreen(): React.JSX.Element {
  const { triggerSync } = useApp();
  const { runTask } = useRemoteTask();
  const [entries, setEntries] = useState<ResumeEntry[]>([]);
  const [openedKey, setOpenedKey] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newText, setNewText] = useState('');

  const reload = useCallback(() => setEntries(listResumeEntries(getRawDb())), []);

  useLocalDataReload(reload);

  const opened = openedKey ? (entries.find((e) => entryKey(e) === openedKey) ?? null) : null;

  const create = async (): Promise<void> => {
    try {
      const id = await runTask('新建简历', async () => {
        const created = await createResumeFromText(getRawDb(), newLabel, newText);
        await triggerSync();
        return created;
      });
      setCreateOpen(false);
      setNewLabel('');
      setNewText('');
      reload();
      setOpenedKey(`resume:${id}`);
    } catch {
      // toast handled by runTask
    }
  };

  const remove = (entry: ResumeEntry): void => {
    Alert.alert(
      '删除简历',
      entry.kind === 'resume'
        ? `确定删除「${entry.label}」？基于它生成的优化版会一并删除。`
        : `确定删除「${entry.label}」这份优化版？`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await runTask('删除简历', async () => {
                  await deleteResumeEntry(getRawDb(), entry.kind, entry.id);
                  await triggerSync();
                  return '已删除';
                });
                if (openedKey === entryKey(entry)) setOpenedKey(null);
                reload();
              } catch {
                // toast handled by runTask
              }
            })();
          },
        },
      ],
    );
  };

  if (opened) {
    return (
      <ResumeEditor
        key={entryKey(opened)}
        entry={opened}
        onBack={() => {
          setOpenedKey(null);
          reload();
        }}
      />
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }}>
        <Text style={{ color: theme.muted, fontSize: 12, lineHeight: 18 }}>
          母版与针对岗位优化过的简历都在这里，编辑自动保存并同步回桌面。模板、预览与导出的 PDF 与桌面一致。
        </Text>

        <Pressable
          onPress={() => setCreateOpen(true)}
          style={{
            borderWidth: 1,
            borderColor: theme.border,
            borderRadius: 10,
            paddingVertical: 10,
            alignItems: 'center',
            backgroundColor: theme.surface,
          }}
        >
          <Text style={{ color: theme.accent, fontSize: 13 }}>+ 粘贴文本新建简历</Text>
        </Pressable>

        {entries.length === 0 ? (
          <Text style={{ color: theme.muted, fontSize: 13 }}>
            还没有简历。可以在这里粘贴文本新建，或在桌面端导入 PDF / Word 后同步过来。
          </Text>
        ) : (
          entries.map((entry) => (
            <View
              key={entryKey(entry)}
              style={{
                flexDirection: 'row',
                alignItems: 'stretch',
                gap: 8,
              }}
            >
              <Pressable
                onPress={() => setOpenedKey(entryKey(entry))}
                style={{
                  flex: 1,
                  borderWidth: 1,
                  borderColor: theme.border,
                  borderRadius: 10,
                  backgroundColor: theme.surface,
                  padding: 12,
                  gap: 4,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={{ flex: 1, color: theme.text, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>
                    {entry.label}
                  </Text>
                  <Text
                    style={{
                      color: entry.kind === 'resume' ? theme.accent : theme.muted,
                      fontSize: 10,
                      borderWidth: 1,
                      borderColor: theme.border,
                      borderRadius: 999,
                      paddingHorizontal: 6,
                      paddingVertical: 1,
                    }}
                  >
                    {entry.kind === 'resume' ? '母版' : '优化版'}
                  </Text>
                </View>
                <Text style={{ color: theme.muted, fontSize: 11 }} numberOfLines={1}>
                  {entry.subtitle}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => remove(entry)}
                style={{
                  justifyContent: 'center',
                  paddingHorizontal: 12,
                  borderWidth: 1,
                  borderColor: theme.border,
                  borderRadius: 10,
                  backgroundColor: theme.surface,
                }}
              >
                <Text style={{ color: theme.danger, fontSize: 11 }}>删除</Text>
              </Pressable>
            </View>
          ))
        )}
      </ScrollView>

      <Modal visible={createOpen} transparent animationType="fade" onRequestClose={() => setCreateOpen(false)}>
        <View style={{ flex: 1, justifyContent: 'center', padding: 16 }}>
          <Pressable
            style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(0,0,0,0.45)' }}
            onPress={() => setCreateOpen(false)}
          />
          <View
            style={{
              borderRadius: 12,
              borderWidth: 1,
              borderColor: theme.border,
              backgroundColor: theme.surface,
              padding: 14,
              gap: 10,
            }}
          >
            <Text style={{ color: theme.text, fontSize: 15, fontWeight: '600' }}>新建简历</Text>
            <TextInput
              value={newLabel}
              onChangeText={setNewLabel}
              placeholder="简历名称，如「后端-2026」"
              placeholderTextColor={theme.muted}
              style={{
                color: theme.text,
                borderWidth: 1,
                borderColor: theme.border,
                borderRadius: 8,
                paddingHorizontal: 10,
                paddingVertical: 8,
                fontSize: 13,
                backgroundColor: theme.bg,
              }}
            />
            <TextInput
              multiline
              value={newText}
              onChangeText={setNewText}
              placeholder="粘贴简历文本，会先按规则识别成固定模块，之后可在编辑器里用 AI 识别重排"
              placeholderTextColor={theme.muted}
              style={{
                color: theme.text,
                borderWidth: 1,
                borderColor: theme.border,
                borderRadius: 8,
                padding: 10,
                fontSize: 13,
                lineHeight: 20,
                minHeight: 180,
                textAlignVertical: 'top',
                backgroundColor: theme.bg,
              }}
            />
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
              <Pressable onPress={() => setCreateOpen(false)} style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
                <Text style={{ color: theme.muted, fontSize: 12 }}>取消</Text>
              </Pressable>
              <Pressable
                onPress={() => void create()}
                disabled={!newText.trim()}
                style={{
                  backgroundColor: theme.accent,
                  borderRadius: 8,
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  opacity: newText.trim() ? 1 : 0.4,
                }}
              >
                <Text style={{ color: '#fff', fontSize: 12 }}>创建并编辑</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}
