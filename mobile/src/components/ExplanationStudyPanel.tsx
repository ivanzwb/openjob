import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, Text, TextInput, View } from 'react-native';
import type { Annotation, Explanation } from '@shared/entities';
import type { ExplanationTier } from '@shared/enums';
import { annotationMarkSummary, sortMarksByContentPosition } from '@shared/annotationMarkList';
import { getRawDb } from '../db';
import {
  createAnnotation,
  deleteAnnotation,
  getExplanation,
  listAnnotations,
  toggleBookmark as toggleBookmarkLocal,
  updateExplanation,
} from '../data/study';
import { elaborateExplanationSelection, generateExplanation } from '../data/explainGen';
import { useApp } from '../context/AppContext';
import { useRemoteTask } from '../context/RemoteTaskContext';
import { useToast } from './Toast';
import { theme } from '../theme';
import { AnnotatedExplanationText } from './AnnotatedExplanationText';
import {
  DEFAULT_HIGHLIGHT_COLOR,
  ExplanationActionModal,
  type ActionModalMode,
} from './ExplanationActionModal';
import {
  findHighlightMark,
  phraseSelectionStart,
  type InlineAnnotation,
  type TextHighlight,
} from '../lib/annotationMarks';

const TIERS: { id: ExplanationTier; label: string }[] = [
  { id: 'oneliner', label: '一句话' },
  { id: 'spoken', label: '口语稿' },
  { id: 'deep', label: '深挖' },
];

function replaceExcerpt(contentMd: string, selected: string, replacement: string): string {
  const sel = selected.trim();
  const rep = replacement.trim();
  if (!sel || !rep) throw new Error('替换内容为空');
  if (contentMd.includes(sel)) return contentMd.replace(sel, rep);
  throw new Error('无法在讲解正文中定位选区，请重新选择词句');
}

export function ExplanationStudyPanel({
  nodeId,
  nodeName,
  tier: initialTier = 'spoken',
}: {
  nodeId: string;
  nodeName: string;
  tier?: ExplanationTier;
}): React.JSX.Element {
  const { runTask } = useRemoteTask();
  const { notifyDataChanged } = useApp();
  const toast = useToast();
  const [tier, setTier] = useState<ExplanationTier>(initialTier);
  const [content, setContent] = useState<Explanation | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftMd, setDraftMd] = useState('');
  const [phrase, setPhrase] = useState('');
  const [selectionStart, setSelectionStart] = useState<number | undefined>(undefined);
  const [modalMode, setModalMode] = useState<ActionModalMode | null>(null);
  const [modalDraft, setModalDraft] = useState('');
  const [highlightColor, setHighlightColor] = useState<string>(DEFAULT_HIGHLIGHT_COLOR);
  const [viewMarker, setViewMarker] = useState<Annotation | null>(null);
  const [focusedMarkId, setFocusedMarkId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const bookmarked = annotations.some((a) => a.kind === 'bookmark');
  const highlightMarks = annotations.filter((a) => a.kind === 'highlight');
  const contentMarks = annotations.filter(
    (a) => a.kind === 'highlight' || a.kind === 'note' || a.kind === 'elaboration',
  );
  const markCount = contentMarks.length;

  const highlights: TextHighlight[] = useMemo(
    () =>
      highlightMarks.map((m) => ({
        text: m.selectedText ?? '',
        color: m.highlightColor ?? DEFAULT_HIGHLIGHT_COLOR,
        ...(m.selectionStart != null ? { start: m.selectionStart } : {}),
      })),
    [highlightMarks],
  );

  const existingHighlight = useMemo(
    () =>
      phrase.trim()
        ? findHighlightMark(phrase, highlightMarks, selectionStart) ?? null
        : null,
    [phrase, highlightMarks, selectionStart],
  );

  const showToast = useCallback(
    (msg: string) => {
      toast(msg, { variant: 'success' });
    },
    [toast],
  );

  const loadAnnotations = useCallback(async (explanationId: string) => {
    const result = listAnnotations(getRawDb(), 'explanation', explanationId);
    setAnnotations(result);
  }, []);

  const loadExplanation = useCallback(
    async (t: ExplanationTier, forceGenerate = false): Promise<void> => {
      setLoading(true);
      setError(null);
      setPhrase('');
      setSelectionStart(undefined);
      setEditing(false);
      setModalMode(null);
      try {
        if (!forceGenerate) {
          const cached = getExplanation(getRawDb(), nodeId, t);
          if (cached?.contentMd) {
            setContent(cached);
            setDraftMd(cached.contentMd);
            await loadAnnotations(cached.id);
            return;
          }
        }
        const generated = await runTask('生成讲解', async () =>
          generateExplanation(getRawDb(), nodeId, t),
        );
        setContent(generated);
        setDraftMd(generated.contentMd);
        await loadAnnotations(generated.id);
        notifyDataChanged();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [nodeId, runTask, loadAnnotations, notifyDataChanged],
  );

  useEffect(() => {
    void loadExplanation(tier);
  }, [nodeId, tier, loadExplanation]);

  const openModal = (mode: ActionModalMode): void => {
    if (!phrase.trim() && mode !== 'viewMarker') return;
    if (mode === 'highlight') {
      const existing = findHighlightMark(phrase, highlightMarks, selectionStart);
      setHighlightColor(existing?.highlightColor ?? DEFAULT_HIGHLIGHT_COLOR);
    }
    if (mode === 'edit') setModalDraft(phrase);
    if (mode === 'note') setModalDraft('');
    if (mode === 'elaboration') setModalDraft('');
    setModalMode(mode);
  };

  const onSegmentPress = (text: string, start: number, markers?: InlineAnnotation[]): void => {
    setPhrase(text);
    setSelectionStart(start);
    if (markers?.length === 1) {
      const ann = annotations.find((a) => a.id === markers[0]!.id);
      if (ann) {
        setViewMarker(ann);
        setModalMode('viewMarker');
      }
      return;
    }
    if (markers && markers.length > 1) {
      const buttons = markers.map((m) => ({
        text: m.kind === 'note' ? '查看笔记' : '查看细化',
        onPress: () => {
          const ann = annotations.find((a) => a.id === m.id);
          if (ann) {
            setViewMarker(ann);
            setModalMode('viewMarker');
          }
        },
      }));
      Alert.alert('选择标记', '该词句有多个标记', [...buttons, { text: '取消', style: 'cancel' }]);
    }
  };

  const locateMark = (mark: Annotation): void => {
    const text = mark.selectedText?.trim();
    if (text) {
      setPhrase(text);
      setSelectionStart(
        mark.selectionStart ??
          (content ? phraseSelectionStart(content.contentMd, text) : undefined),
      );
    }
    setFocusedMarkId(mark.id);
    if (mark.kind === 'note' || mark.kind === 'elaboration') {
      setViewMarker(mark);
      setModalMode('viewMarker');
    }
    setTimeout(() => setFocusedMarkId(null), 2400);
  };

  const showMarkList = (): void => {
    if (!content || !contentMarks.length) return;
    const sorted = sortMarksByContentPosition(contentMarks, content.contentMd);
    Alert.alert(
      '标记列表',
      '选择要定位的标记',
      [
        ...sorted.map((mark) => ({
          text: annotationMarkSummary(mark),
          onPress: () => locateMark(mark),
        })),
        { text: '取消', style: 'cancel' },
      ],
    );
  };

  const saveFullEdit = async (): Promise<void> => {
    if (!content) return;
    try {
      const result = await updateExplanation(getRawDb(), content.id, draftMd);
      setContent(result);
      setDraftMd(result.contentMd);
      setEditing(false);
      showToast('讲解已保存');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const confirmRegenerate = (): void => {
    const tierLabel = TIERS.find((t) => t.id === tier)?.label ?? tier;
    const edited = content?.modelUsed === 'user-edit';
    Alert.alert(
      '重新生成',
      edited
        ? `你已手动修改过讲解。重新生成将覆盖当前「${tierLabel}」内容，确定继续？`
        : `重新生成将覆盖当前「${tierLabel}」讲解内容，确定继续？`,
      [
        { text: '取消', style: 'cancel' },
        { text: '继续', style: 'destructive', onPress: () => void loadExplanation(tier, true) },
      ],
    );
  };

  const toggleBookmark = async (): Promise<void> => {
    if (!content) return;
    try {
      await toggleBookmarkLocal(getRawDb(), 'explanation', content.id);
      await loadAnnotations(content.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const saveHighlight = async (): Promise<void> => {
    if (!content || !phrase.trim()) return;
    setBusy(true);
    try {
      const trimmed = phrase.trim().slice(0, 500);
      const start = selectionStart ?? phraseSelectionStart(content.contentMd, trimmed);
      const existing = findHighlightMark(phrase, highlightMarks, start);
      if (existing) await deleteAnnotation(getRawDb(), existing.id);
      await createAnnotation(getRawDb(), {
        targetType: 'explanation',
        targetId: content.id,
        kind: 'highlight',
        selectedText: trimmed,
        highlightColor,
        ...(start !== undefined ? { selectionStart: start } : {}),
      });
      await loadAnnotations(content.id);
      setModalMode(null);
      showToast(existing ? '高亮已更新' : '已添加高亮');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const clearHighlight = async (): Promise<void> => {
    if (!content) return;
    const mark = findHighlightMark(phrase, highlightMarks, selectionStart);
    if (!mark) return;
    setBusy(true);
    try {
      await deleteAnnotation(getRawDb(), mark.id);
      await loadAnnotations(content.id);
      setModalMode(null);
      showToast('高亮已清除');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveNote = async (): Promise<void> => {
    if (!content || !modalDraft.trim()) return;
    setBusy(true);
    try {
      const trimmed = phrase.trim().slice(0, 500);
      await createAnnotation(getRawDb(), {
        targetType: 'explanation',
        targetId: content.id,
        kind: 'note',
        noteMd: modalDraft.trim(),
        ...(trimmed ? { selectedText: trimmed } : {}),
      });
      await loadAnnotations(content.id);
      setModalMode(null);
      setModalDraft('');
      showToast('笔记已保存');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveEditExcerpt = async (): Promise<void> => {
    if (!content || !phrase.trim() || !modalDraft.trim()) return;
    setBusy(true);
    try {
      const nextMd = replaceExcerpt(content.contentMd, phrase, modalDraft);
      const result = await updateExplanation(getRawDb(), content.id, nextMd);
      setContent(result);
      setDraftMd(result.contentMd);
      setModalMode(null);
      setPhrase('');
      setSelectionStart(undefined);
      showToast('讲解已更新');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveElaboration = async (): Promise<void> => {
    const text = phrase.trim();
    if (!text || !content) return;
    setBusy(true);
    try {
      const result = await runTask('细化讲解', async () =>
        elaborateExplanationSelection(getRawDb(), nodeId, tier, text, content.contentMd),
      );
      await createAnnotation(getRawDb(), {
        targetType: 'explanation',
        targetId: content.id,
        kind: 'elaboration',
        noteMd: result.elaborationMd,
        selectedText: result.selectedText.slice(0, 500),
      });
      await loadAnnotations(content.id);
      setModalMode(null);
      showToast('细化讲解已保存');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteMarker = async (): Promise<void> => {
    if (!viewMarker || !content) return;
    setBusy(true);
    try {
      await deleteAnnotation(getRawDb(), viewMarker.id);
      await loadAnnotations(content.id);
      setModalMode(null);
      setViewMarker(null);
      showToast('标记已删除');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <Text style={{ color: theme.muted, fontSize: 13 }}>加载讲解…</Text>;
  }

  if (error) {
    return <Text style={{ color: theme.danger, fontSize: 13 }}>{error}</Text>;
  }

  if (!content) {
    return <Text style={{ color: theme.muted, fontSize: 13 }}>暂无「{nodeName}」的讲解</Text>;
  }

  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {TIERS.map((t) => (
          <Pressable
            key={t.id}
            onPress={() => setTier(t.id)}
            style={{
              paddingHorizontal: 10,
              paddingVertical: 5,
              borderRadius: 8,
              backgroundColor: tier === t.id ? theme.accent : theme.bg,
            }}
          >
            <Text style={{ color: tier === t.id ? '#fff' : theme.muted, fontSize: 12 }}>{t.label}</Text>
          </Pressable>
        ))}
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <Pressable onPress={() => void toggleBookmark()} style={btnGhost}>
          <Text style={{ color: bookmarked ? '#fbbf24' : theme.muted, fontSize: 12 }}>
            {bookmarked ? '★ 已收藏' : '☆ 收藏'}
          </Text>
        </Pressable>
        {markCount > 0 && (
          <Pressable onPress={showMarkList} hitSlop={6}>
            <Text style={{ color: theme.accent, fontSize: 11 }}>{markCount} 条标记</Text>
          </Pressable>
        )}
        {!editing && (
          <>
            <Pressable onPress={() => setEditing(true)} style={btnGhost}>
              <Text style={{ color: theme.accent, fontSize: 12 }}>编辑全文</Text>
            </Pressable>
            <Pressable onPress={confirmRegenerate} style={btnGhost}>
              <Text style={{ color: theme.muted, fontSize: 12 }}>重新生成</Text>
            </Pressable>
          </>
        )}
      </View>

      {editing ? (
        <>
          <TextInput
            multiline
            value={draftMd}
            onChangeText={setDraftMd}
            style={{
              minHeight: 200,
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
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Pressable
              onPress={() => void saveFullEdit()}
              style={{ backgroundColor: theme.accent, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 }}
            >
              <Text style={{ color: '#fff', fontSize: 12 }}>保存修改</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setDraftMd(content.contentMd);
                setEditing(false);
              }}
              style={{ paddingHorizontal: 12, paddingVertical: 8 }}
            >
              <Text style={{ color: theme.muted, fontSize: 12 }}>取消</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <AnnotatedExplanationText
          contentMd={content.contentMd}
          highlights={highlights}
          annotations={annotations}
          onSegmentPress={onSegmentPress}
          focusedMarkId={focusedMarkId}
        />
      )}

      {!editing && (
        <View style={{ gap: 6 }}>
          <Text style={{ color: theme.muted, fontSize: 11 }}>
            输入或点选讲解中的词句，再进行高亮 / 笔记 / 细化
          </Text>
          <TextInput
            value={phrase}
            onChangeText={(v) => {
              setPhrase(v);
              setSelectionStart(
                content && v.trim() ? phraseSelectionStart(content.contentMd, v) : undefined,
              );
            }}
            placeholder="例如：CAS、双亲委派…"
            placeholderTextColor={theme.muted}
            style={{
              color: theme.text,
              borderWidth: 1,
              borderColor: theme.border,
              borderRadius: 8,
              paddingHorizontal: 10,
              paddingVertical: 8,
              fontSize: 13,
            }}
          />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Pressable
              onPress={() => openModal('highlight')}
              disabled={!phrase.trim()}
              style={[actionBtn, !phrase.trim() && { opacity: 0.5 }]}
            >
              <Text style={{ color: theme.accent, fontSize: 12 }}>划词高亮</Text>
            </Pressable>
            <Pressable
              onPress={() => openModal('note')}
              disabled={!phrase.trim()}
              style={[actionBtn, !phrase.trim() && { opacity: 0.5 }]}
            >
              <Text style={{ color: theme.accent, fontSize: 12 }}>记笔记</Text>
            </Pressable>
            <Pressable
              onPress={() => openModal('elaboration')}
              disabled={!phrase.trim()}
              style={[actionBtn, !phrase.trim() && { opacity: 0.5 }]}
            >
              <Text style={{ color: theme.accent, fontSize: 12 }}>细化讲解</Text>
            </Pressable>
            <Pressable
              onPress={() => openModal('edit')}
              disabled={!phrase.trim()}
              style={[actionBtn, !phrase.trim() && { opacity: 0.5 }]}
            >
              <Text style={{ color: theme.accent, fontSize: 12 }}>编辑词句</Text>
            </Pressable>
          </View>
        </View>
      )}

      <ExplanationActionModal
        visible={modalMode !== null}
        mode={modalMode}
        phrase={phrase}
        draft={modalDraft}
        highlightColor={highlightColor}
        existingHighlight={existingHighlight}
        marker={viewMarker}
        busy={busy}
        onDraftChange={setModalDraft}
        onHighlightColorChange={setHighlightColor}
        onClose={() => {
          setModalMode(null);
          setViewMarker(null);
        }}
        onSaveHighlight={() => void saveHighlight()}
        onClearHighlight={() => void clearHighlight()}
        onSaveNote={() => void saveNote()}
        onSaveEdit={() => void saveEditExcerpt()}
        onSaveElaboration={() => void saveElaboration()}
        onDeleteMarker={() => void deleteMarker()}
      />
    </View>
  );
}

const btnGhost = {
  paddingHorizontal: 8,
  paddingVertical: 4,
  borderRadius: 8,
  backgroundColor: theme.bg,
} as const;

const actionBtn = {
  paddingHorizontal: 10,
  paddingVertical: 6,
  borderRadius: 8,
  backgroundColor: theme.bg,
} as const;
