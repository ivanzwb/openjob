import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { Annotation } from '@shared/entities';
import { DEFAULT_HIGHLIGHT_COLOR, HIGHLIGHT_COLORS } from '../lib/annotationMarks';
import { theme } from '../theme';

export type ActionModalMode = 'highlight' | 'note' | 'edit' | 'elaboration' | 'viewMarker';

export function ExplanationActionModal({
  visible,
  mode,
  phrase,
  draft,
  highlightColor,
  existingHighlight,
  marker,
  busy,
  onDraftChange,
  onHighlightColorChange,
  onClose,
  onSaveHighlight,
  onClearHighlight,
  onSaveNote,
  onSaveEdit,
  onSaveElaboration,
  onDeleteMarker,
}: {
  visible: boolean;
  mode: ActionModalMode | null;
  phrase: string;
  draft: string;
  highlightColor: string;
  existingHighlight: Annotation | null;
  marker: Annotation | null;
  busy: boolean;
  onDraftChange: (v: string) => void;
  onHighlightColorChange: (c: string) => void;
  onClose: () => void;
  onSaveHighlight: () => void;
  onClearHighlight: () => void;
  onSaveNote: () => void;
  onSaveEdit: () => void;
  onSaveElaboration: () => void;
  onDeleteMarker: () => void;
}): React.JSX.Element {
  const title =
    mode === 'highlight'
      ? '划词高亮'
      : mode === 'note'
        ? '记笔记'
        : mode === 'edit'
          ? '编辑讲解'
          : mode === 'elaboration'
            ? '细化讲解'
            : mode === 'viewMarker'
              ? marker?.kind === 'note'
                ? '笔记'
                : '细化讲解'
              : '';

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }}
        onPress={onClose}
      >
        <Pressable
          style={{
            maxHeight: '80%',
            backgroundColor: theme.surface,
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            padding: 16,
            gap: 10,
          }}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ color: theme.text, fontSize: 15, fontWeight: '600' }}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={{ color: theme.muted, fontSize: 13 }}>关闭</Text>
            </Pressable>
          </View>

          {phrase && mode !== 'viewMarker' && (
            <Text style={{ color: theme.muted, fontSize: 11 }} numberOfLines={2}>
              「{phrase}」
            </Text>
          )}

          {mode === 'viewMarker' && marker && (
            <ScrollView style={{ maxHeight: 320 }}>
              {marker.selectedText && (
                <Text style={{ color: theme.muted, fontSize: 11, marginBottom: 8 }}>
                  「{marker.selectedText}」
                </Text>
              )}
              <Text style={{ color: theme.text, fontSize: 13, lineHeight: 20 }}>{marker.noteMd}</Text>
            </ScrollView>
          )}

          {mode === 'highlight' && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {HIGHLIGHT_COLORS.map((c) => (
                <Pressable
                  key={c}
                  onPress={() => onHighlightColorChange(c)}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 14,
                    backgroundColor: c,
                    borderWidth: highlightColor === c ? 2 : 1,
                    borderColor: highlightColor === c ? theme.accent : '#00000033',
                  }}
                />
              ))}
            </View>
          )}

          {mode === 'elaboration' && (
            <Text style={{ color: theme.muted, fontSize: 12, lineHeight: 18 }}>
              将根据选中的词句生成细化讲解，并保存为内联标记。
            </Text>
          )}

          {(mode === 'note' || mode === 'edit') && (
            <TextInput
              multiline
              value={draft}
              onChangeText={onDraftChange}
              placeholder={
                mode === 'note' ? '写下你的笔记…' : '替换为新的讲解内容…'
              }
              placeholderTextColor={theme.muted}
              editable={!busy}
              style={{
                minHeight: mode === 'edit' ? 160 : 100,
                color: theme.text,
                borderWidth: 1,
                borderColor: theme.border,
                borderRadius: 8,
                padding: 10,
                textAlignVertical: 'top',
                fontSize: 13,
                lineHeight: 20,
              }}
            />
          )}

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
            {mode === 'viewMarker' && marker && (
              <Pressable
                onPress={onDeleteMarker}
                disabled={busy}
                style={{ paddingHorizontal: 12, paddingVertical: 8 }}
              >
                <Text style={{ color: theme.danger, fontSize: 13 }}>删除</Text>
              </Pressable>
            )}

            {mode === 'highlight' && existingHighlight && (
              <Pressable
                onPress={onClearHighlight}
                disabled={busy}
                style={{ paddingHorizontal: 12, paddingVertical: 8 }}
              >
                <Text style={{ color: theme.danger, fontSize: 13 }}>
                  {busy ? '清除中…' : '清除高亮'}
                </Text>
              </Pressable>
            )}

            {mode === 'highlight' && (
              <Pressable
                onPress={onSaveHighlight}
                disabled={busy || !phrase.trim()}
                style={{
                  backgroundColor: theme.accent,
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  borderRadius: 8,
                  opacity: busy || !phrase.trim() ? 0.5 : 1,
                }}
              >
                <Text style={{ color: '#fff', fontSize: 13 }}>
                  {busy ? '保存中…' : existingHighlight ? '更新高亮' : '确认高亮'}
                </Text>
              </Pressable>
            )}

            {mode === 'note' && (
              <Pressable
                onPress={onSaveNote}
                disabled={busy || !draft.trim()}
                style={{
                  backgroundColor: theme.accent,
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  borderRadius: 8,
                  opacity: busy || !draft.trim() ? 0.5 : 1,
                }}
              >
                <Text style={{ color: '#fff', fontSize: 13 }}>{busy ? '保存中…' : '保存笔记'}</Text>
              </Pressable>
            )}

            {mode === 'edit' && (
              <Pressable
                onPress={onSaveEdit}
                disabled={busy || !draft.trim()}
                style={{
                  backgroundColor: theme.accent,
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  borderRadius: 8,
                  opacity: busy || !draft.trim() ? 0.5 : 1,
                }}
              >
                <Text style={{ color: '#fff', fontSize: 13 }}>{busy ? '保存中…' : '替换并保存'}</Text>
              </Pressable>
            )}

            {mode === 'elaboration' && (
              <Pressable
                onPress={onSaveElaboration}
                disabled={busy || !phrase.trim()}
                style={{
                  backgroundColor: theme.accent,
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  borderRadius: 8,
                  opacity: busy || !phrase.trim() ? 0.5 : 1,
                }}
              >
                <Text style={{ color: '#fff', fontSize: 13 }}>
                  {busy ? '生成中…' : '生成并保存'}
                </Text>
              </Pressable>
            )}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export { DEFAULT_HIGHLIGHT_COLOR };
