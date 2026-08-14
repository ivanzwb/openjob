import { useMemo, useRef, useState } from 'react';
import {
  Dimensions,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type GestureResponderEvent,
  type PanResponderGestureState,
} from 'react-native';
import type { Annotation } from '@shared/entities';
import { DEFAULT_HIGHLIGHT_COLOR, HIGHLIGHT_COLORS } from '../lib/annotationMarks';
import { useTheme } from '../theme';

export type ActionModalMode = 'highlight' | 'note' | 'edit' | 'elaboration' | 'viewMarker';

type PanelPreset = 'edit' | 'note' | 'default';

const PANEL_PRESETS: Record<
  PanelPreset,
  { minWidth: number; minHeight: number; defaultWidth: number; defaultHeight: number }
> = {
  edit: { minWidth: 300, minHeight: 280, defaultWidth: 0.92, defaultHeight: 380 },
  note: { minWidth: 280, minHeight: 220, defaultWidth: 0.9, defaultHeight: 300 },
  default: { minWidth: 280, minHeight: 180, defaultWidth: 0.9, defaultHeight: 260 },
};

function panelPreset(mode: ActionModalMode | null): PanelPreset {
  if (mode === 'edit') return 'edit';
  if (mode === 'note') return 'note';
  return 'default';
}

function useResizablePanel(mode: ActionModalMode | null): {
  width: number;
  height: number;
  resizeResponder: ReturnType<typeof PanResponder.create>;
} {
  const screen = Dimensions.get('window');
  const preset = PANEL_PRESETS[panelPreset(mode)];
  const defaultW = preset.defaultWidth <= 1 ? screen.width * preset.defaultWidth : preset.defaultWidth;
  const [size, setSize] = useState({
    width: Math.min(screen.width - 24, Math.max(preset.minWidth, defaultW)),
    height: Math.min(screen.height * 0.75, Math.max(preset.minHeight, preset.defaultHeight)),
  });
  const startSizeRef = useRef(size);

  const resizeResponder = useMemo(
    () =>
      // PanResponder.create 只是登记手势回调，ref 要等手势真正发生才读，不存在 render 期访问
      // eslint-disable-next-line react-hooks/refs
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          startSizeRef.current = size;
        },
        onPanResponderMove: (_evt: GestureResponderEvent, gesture: PanResponderGestureState) => {
          const maxW = screen.width - 24;
          const maxH = screen.height * 0.8;
          const start = startSizeRef.current;
          setSize({
            width: Math.min(maxW, Math.max(preset.minWidth, start.width + gesture.dx)),
            height: Math.min(maxH, Math.max(preset.minHeight, start.height + gesture.dy)),
          });
        },
      }),
    [preset.minHeight, preset.minWidth, screen.height, screen.width, size],
  );

  return { width: size.width, height: size.height, resizeResponder };
}

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
  const theme = useTheme();
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

  const resizable = mode === 'note' || mode === 'edit' || mode === 'viewMarker';
  const { width, height, resizeResponder } = useResizablePanel(mode);
  const useCenterPanel = mode === 'note' || mode === 'edit' || mode === 'viewMarker';

  const panelBody = (
    <View
      style={{
        width: resizable ? width : undefined,
        height: resizable ? height : undefined,
        maxHeight: resizable ? undefined : '80%',
        minWidth: resizable ? PANEL_PRESETS[panelPreset(mode)].minWidth : undefined,
        backgroundColor: theme.surface,
        borderRadius: 16,
        padding: 16,
        gap: 10,
        alignSelf: useCenterPanel ? 'center' : 'stretch',
      }}
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
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 8 }}>
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
          placeholder={mode === 'note' ? '写下你的笔记…' : '替换为新的讲解内容…'}
          placeholderTextColor={theme.muted}
          editable={!busy}
          style={{
            flex: 1,
            minHeight: mode === 'edit' ? 200 : 160,
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
          <Pressable onPress={onDeleteMarker} disabled={busy} style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
            <Text style={{ color: theme.danger, fontSize: 13 }}>删除</Text>
          </Pressable>
        )}

        {mode === 'highlight' && existingHighlight && (
          <Pressable onPress={onClearHighlight} disabled={busy} style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
            <Text style={{ color: theme.danger, fontSize: 13 }}>{busy ? '清除中…' : '清除高亮'}</Text>
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
            <Text style={{ color: '#fff', fontSize: 13 }}>{busy ? '生成中…' : '生成并保存'}</Text>
          </Pressable>
        )}
      </View>

      {resizable && (
        <View
          {...resizeResponder.panHandlers}
          style={{
            position: 'absolute',
            right: 4,
            bottom: 4,
            width: 28,
            height: 28,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ color: theme.muted, fontSize: 16, lineHeight: 16 }}>◢</Text>
        </View>
      )}
    </View>
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={{
          flex: 1,
          backgroundColor: theme.scrim,
          justifyContent: useCenterPanel ? 'center' : 'flex-end',
          padding: 16,
        }}
        onPress={onClose}
      >
        <Pressable onPress={(e) => e.stopPropagation()} style={{ width: '100%' }}>
          {panelBody}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export { DEFAULT_HIGHLIGHT_COLOR };
