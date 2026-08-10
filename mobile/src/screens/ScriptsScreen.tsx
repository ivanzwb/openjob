import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { SpeechSnippetView } from '@shared/ipc';
import { getRawDb } from '../db';
import { listSpeechSnippets } from '../data/queries';
import { deleteSpeech, updateSpeech } from '../data/mutations';
import { useApp } from '../context/AppContext';
import { theme } from '../theme';

export function ScriptsScreen(): React.JSX.Element {
  const { triggerSync } = useApp();
  const [items, setItems] = useState<SpeechSnippetView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const reload = useCallback(() => {
    const list = listSpeechSnippets(getRawDb());
    setItems(list);
    const id = selected ?? list[0]?.id ?? null;
    setSelected(id);
    setDraft(list.find((s) => s.id === id)?.contentMd ?? '');
  }, [selected]);

  useEffect(() => {
    reload();
  }, [reload]);

  const save = async () => {
    if (!selected) return;
    await updateSpeech(getRawDb(), selected, draft);
    await triggerSync();
    reload();
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, flexDirection: 'row' }}>
      <ScrollView style={{ width: 140, borderRightWidth: 1, borderColor: theme.border }}>
        {items.map((s) => (
          <Pressable key={s.id} onPress={() => { setSelected(s.id); setDraft(s.contentMd); }} style={{ padding: 10 }}>
            <Text style={{ color: selected === s.id ? theme.accent : theme.text, fontSize: 11 }} numberOfLines={2}>
              {s.sourceLabel}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      <View style={{ flex: 1, padding: 12, gap: 8 }}>
        <TextInput
          multiline
          value={draft}
          onChangeText={setDraft}
          style={{ flex: 1, color: theme.text, borderWidth: 1, borderColor: theme.border, borderRadius: 8, padding: 10, textAlignVertical: 'top' }}
        />
        <Pressable onPress={() => void save()} style={{ backgroundColor: theme.accent, padding: 10, borderRadius: 8, alignItems: 'center' }}>
          <Text style={{ color: '#fff' }}>保存并同步</Text>
        </Pressable>
        {selected && (
          <Pressable
            onPress={() => void deleteSpeech(getRawDb(), selected).then(() => triggerSync()).then(reload)}
            style={{ alignItems: 'center' }}
          >
            <Text style={{ color: theme.danger }}>删除</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}
