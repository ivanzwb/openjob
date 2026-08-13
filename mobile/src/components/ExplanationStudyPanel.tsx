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
import { isTaskRunning, runTask, useTaskResult, useTaskState } from '../context/RemoteTaskContext';
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
  const { notifyDataChanged } = useApp();
  const [tier, setTier] = useState<ExplanationTier>(initialTier);
  const [content, setContent] = useState<Explanation | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [editing, setEditing] = useState(false);
  const [draftMd, setDraftMd] = useState('');
  const [phrase, setPhrase] = useState('');
  const [selectionStart, setSelectionStart] = useState<number | undefined>(undefined);
  const [modalMode, setModalMode] = useState<ActionModalMode | null>(null);
  const [modalDraft, setModalDraft] = useState('');
  const [highlightColor, setHighlightColor] = useState<string>(DEFAULT_HIGHLIGHT_COLOR);
  const [viewMarker, setViewMarker] = useState<Annotation | null>(null);
  const [focusedMarkId, setFocusedMarkId] = useState<string | null>(null);

  // 按「考点 + 档位」记讲解任务，按考点记标注类操作：
  // 切页、换档位、关掉弹窗再回来，都能看到还在跑，也不会重复发起同一件事
  const loadKey = `explain:load:${nodeId}:${tier}`;
  const regenerateKey = `explain:regenerate:${nodeId}:${tier}`;
  const elaborateKey = `explain:elaborate:${nodeId}:${tier}`;
  const fullEditKey = `explain:fullEdit:${nodeId}`;
  const bookmarkKey = `explain:bookmark:${nodeId}`;
  const highlightKey = `explain:highlight:${nodeId}`;
  const clearHighlightKey = `explain:clearHighlight:${nodeId}`;
  const noteKey = `explain:note:${nodeId}`;
  const excerptKey = `explain:excerpt:${nodeId}`;
  const deleteMarkKey = `explain:deleteMark:${nodeId}`;

  const { running: generating, error: loadError } = useTaskState(loadKey);
  const { running: regenerating, error: regenerateError } = useTaskState(regenerateKey);
  const { running: elaborating } = useTaskState(elaborateKey);
  const { running: savingFullEdit } = useTaskState(fullEditKey);
  const { running: savingHighlight } = useTaskState(highlightKey);
  const { running: clearingHighlight } = useTaskState(clearHighlightKey);
  const { running: savingNote } = useTaskState(noteKey);
  const { running: savingExcerpt } = useTaskState(excerptKey);
  const { running: deletingMark } = useTaskState(deleteMarkKey);
  const busy =
    elaborating ||
    savingHighlight ||
    clearingHighlight ||
    savingNote ||
    savingExcerpt ||
    deletingMark;

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

  const loadAnnotations = useCallback((explanationId: string) => {
    setAnnotations(listAnnotations(getRawDb(), 'explanation', explanationId));
  }, []);

  const adopt = useCallback(
    (explanation: Explanation) => {
      setContent(explanation);
      setDraftMd(explanation.contentMd);
      loadAnnotations(explanation.id);
    },
    [loadAnnotations],
  );

  // 生成结果由 generateExplanation 自己落库，所以重新挂载时先读库，读不到才去生成
  useTaskResult<Explanation>(loadKey, adopt);
  useTaskResult<Explanation>(regenerateKey, adopt);

  useEffect(() => {
    setPhrase('');
    setSelectionStart(undefined);
    setEditing(false);
    setModalMode(null);
    const cached = getExplanation(getRawDb(), nodeId, tier);
    if (cached?.contentMd) {
      adopt(cached);
      return;
    }
    setContent(null);
    if (isTaskRunning(loadKey)) return;
    void runTask(loadKey, '生成讲解', async () => {
      const generated = await generateExplanation(getRawDb(), nodeId, tier);
      notifyDataChanged();
      return generated;
    }).catch(() => undefined);
  }, [nodeId, tier, loadKey, adopt, notifyDataChanged]);

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

  const saveFullEdit = (): void => {
    if (!content) return;
    const target = { id: content.id, contentMd: draftMd };
    void runTask(fullEditKey, '保存讲解', () =>
      updateExplanation(getRawDb(), target.id, target.contentMd),
    ).catch(() => undefined);
  };

  useTaskResult<Explanation>(fullEditKey, (result) => {
    adopt(result);
    setEditing(false);
  });

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
        {
          text: '继续',
          style: 'destructive',
          onPress: () => {
            void runTask(regenerateKey, '重新生成讲解', async () => {
              const generated = await generateExplanation(getRawDb(), nodeId, tier);
              notifyDataChanged();
              return generated;
            }).catch(() => undefined);
          },
        },
      ],
    );
  };

  const toggleBookmark = (): void => {
    if (!content) return;
    const explanationId = content.id;
    void runTask(bookmarkKey, '收藏', async () => {
      await toggleBookmarkLocal(getRawDb(), 'explanation', explanationId);
      return '已更新收藏';
    })
      .then(() => loadAnnotations(explanationId))
      .catch(() => undefined);
  };

  const saveHighlight = (): void => {
    if (!content || !phrase.trim()) return;
    const explanationId = content.id;
    const trimmed = phrase.trim().slice(0, 500);
    const start = selectionStart ?? phraseSelectionStart(content.contentMd, trimmed);
    const existing = findHighlightMark(phrase, highlightMarks, start);
    void runTask(highlightKey, '高亮', async () => {
      if (existing) await deleteAnnotation(getRawDb(), existing.id);
      await createAnnotation(getRawDb(), {
        targetType: 'explanation',
        targetId: explanationId,
        kind: 'highlight',
        selectedText: trimmed,
        highlightColor,
        ...(start !== undefined ? { selectionStart: start } : {}),
      });
      return existing ? '高亮已更新' : '已添加高亮';
    })
      .then(() => {
        loadAnnotations(explanationId);
        setModalMode(null);
      })
      .catch(() => undefined);
  };

  const clearHighlight = (): void => {
    if (!content) return;
    const explanationId = content.id;
    const mark = findHighlightMark(phrase, highlightMarks, selectionStart);
    if (!mark) return;
    void runTask(clearHighlightKey, '清除高亮', async () => {
      await deleteAnnotation(getRawDb(), mark.id);
      return '高亮已清除';
    })
      .then(() => {
        loadAnnotations(explanationId);
        setModalMode(null);
      })
      .catch(() => undefined);
  };

  const saveNote = (): void => {
    if (!content || !modalDraft.trim()) return;
    const explanationId = content.id;
    const trimmed = phrase.trim().slice(0, 500);
    const noteMd = modalDraft.trim();
    void runTask(noteKey, '记笔记', async () => {
      await createAnnotation(getRawDb(), {
        targetType: 'explanation',
        targetId: explanationId,
        kind: 'note',
        noteMd,
        ...(trimmed ? { selectedText: trimmed } : {}),
      });
      return '笔记已保存';
    })
      .then(() => {
        loadAnnotations(explanationId);
        setModalMode(null);
        setModalDraft('');
      })
      .catch(() => undefined);
  };

  const saveEditExcerpt = (): void => {
    if (!content || !phrase.trim() || !modalDraft.trim()) return;
    const target = { id: content.id, contentMd: content.contentMd, phrase, draft: modalDraft };
    void runTask(excerptKey, '编辑词句', () =>
      updateExplanation(
        getRawDb(),
        target.id,
        replaceExcerpt(target.contentMd, target.phrase, target.draft),
      ),
    )
      .then((result) => {
        adopt(result);
        setModalMode(null);
        setPhrase('');
        setSelectionStart(undefined);
      })
      .catch(() => undefined);
  };

  const saveElaboration = (): void => {
    const text = phrase.trim();
    if (!text || !content) return;
    const target = { id: content.id, contentMd: content.contentMd };
    // 细化要请求模型，落库放在任务里：切走再回来，标记已经在正文上了
    void runTask(elaborateKey, '细化讲解', async () => {
      const result = await elaborateExplanationSelection(
        getRawDb(),
        nodeId,
        tier,
        text,
        target.contentMd,
      );
      await createAnnotation(getRawDb(), {
        targetType: 'explanation',
        targetId: target.id,
        kind: 'elaboration',
        noteMd: result.elaborationMd,
        selectedText: result.selectedText.slice(0, 500),
      });
      return '细化讲解已保存';
    }).catch(() => undefined);
  };

  useTaskResult(elaborateKey, () => {
    if (content) loadAnnotations(content.id);
    setModalMode(null);
  });

  const deleteMarker = (): void => {
    if (!viewMarker || !content) return;
    const explanationId = content.id;
    const markId = viewMarker.id;
    void runTask(deleteMarkKey, '删除标记', async () => {
      await deleteAnnotation(getRawDb(), markId);
      return '标记已删除';
    })
      .then(() => {
        loadAnnotations(explanationId);
        setModalMode(null);
        setViewMarker(null);
      })
      .catch(() => undefined);
  };

  if (!content && (generating || regenerating)) {
    return <Text style={{ color: theme.muted, fontSize: 13 }}>生成讲解中…</Text>;
  }

  const failure = loadError ?? regenerateError;
  if (!content && failure !== null) {
    return <Text style={{ color: theme.danger, fontSize: 13 }}>{failure}</Text>;
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
        <Pressable onPress={toggleBookmark} style={btnGhost}>
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
            <Pressable onPress={confirmRegenerate} disabled={regenerating} style={btnGhost}>
              <Text style={{ color: theme.muted, fontSize: 12, opacity: regenerating ? 0.5 : 1 }}>
                {regenerating ? '重新生成中…' : '重新生成'}
              </Text>
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
              onPress={saveFullEdit}
              disabled={savingFullEdit}
              style={{
                backgroundColor: theme.accent,
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderRadius: 8,
                opacity: savingFullEdit ? 0.5 : 1,
              }}
            >
              <Text style={{ color: '#fff', fontSize: 12 }}>{savingFullEdit ? '保存中…' : '保存修改'}</Text>
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
        onSaveHighlight={saveHighlight}
        onClearHighlight={clearHighlight}
        onSaveNote={saveNote}
        onSaveEdit={saveEditExcerpt}
        onSaveElaboration={saveElaboration}
        onDeleteMarker={deleteMarker}
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
