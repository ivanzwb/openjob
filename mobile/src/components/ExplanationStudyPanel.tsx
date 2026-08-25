import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { Annotation, Explanation } from '@shared/entities';
import type { ExplanationTier } from '@shared/enums';
import {
  annotationMarkSummary,
  findMarkOnSelection,
  sortMarksByContentPosition,
} from '@shared/annotationMarkList';
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
import { saveSpeechFromNode } from '../data/mutations';
import { useApp } from '../context/AppContext';
import {
  isTaskRunning,
  runTask,
  useRunningTaskCount,
  useTaskResult,
  useTaskState,
} from '../context/RemoteTaskContext';
import { useTheme, type Palette } from '../theme';
import { ExplanationActionModal, type ActionModalMode } from './ExplanationActionModal';
import {
  DEFAULT_HIGHLIGHT_COLOR,
  findHighlightMark,
  phraseSelectionStart,
} from '../lib/annotationMarks';
import { markdownToAnnotatedSelectionHtml } from '../lib/markdownDisplay';
import { useLocalDataReload } from '../hooks/useLocalDataReload';

const TIERS: { id: ExplanationTier; label: string }[] = [
  { id: 'oneliner', label: '一句话' },
  { id: 'spoken', label: '口语稿' },
  { id: 'deep', label: '深挖' },
];

const EXPLANATION_GENERATION_GROUP = 'explain:generation';
const EXPLANATION_ELABORATION_GROUP = 'explain:elaboration';
const MAX_PARALLEL_GENERATIONS = 1;
const MAX_PARALLEL_ELABORATIONS = 1;

type SelectionAction = 'highlight' | 'note' | 'elaboration' | 'edit' | 'speech';

type SelectionWebMessage =
  | { type: 'height'; height: number }
  | { type: 'clear' }
  | { type: 'marker'; id: string }
  | { type: 'selection'; text: string; start: number }
  | { type: 'action'; action: SelectionAction; text: string; start: number };

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function annotationStart(contentMd: string, mark: Annotation): number | undefined {
  const selected = mark.selectedText?.trim();
  if (!selected) return undefined;
  if (
    mark.selectionStart != null &&
    contentMd.slice(mark.selectionStart, mark.selectionStart + selected.length) === selected
  ) {
    return mark.selectionStart;
  }
  const fallback = contentMd.indexOf(selected);
  return fallback >= 0 ? fallback : undefined;
}

function resolveSelectionStart(contentMd: string, text: string, start: number): number {
  const trimmed = text.trim();
  if (!trimmed) return start;
  if (contentMd.slice(start, start + trimmed.length) === trimmed) return start;
  return phraseSelectionStart(contentMd, trimmed) ?? start;
}

function buildSelectionHtml(
  contentMd: string,
  annotations: Annotation[],
  savedSpeechTexts: Set<string>,
  theme: Palette,
  options: { elaborationDisabled: boolean },
): string {
  const body = markdownToAnnotatedSelectionHtml(
    contentMd,
    annotations,
    DEFAULT_HIGHLIGHT_COLOR,
  );
  const markerMeta = Object.fromEntries(
    annotations
      .filter((a) => a.kind === 'note' || a.kind === 'elaboration')
      .map((a) => [a.id, { kind: a.kind }]),
  );
  const selectionMarks = annotations
    .filter((a) => a.kind === 'note' || a.kind === 'elaboration')
    .map((a) => ({
      kind: a.kind,
      text: a.selectedText?.trim() ?? '',
      start: annotationStart(contentMd, a),
    }))
    .filter((a) => a.text.length > 0);
  const textColor = escapeHtml(theme.text);
  const bgColor = escapeHtml(theme.bg);
  const surfaceColor = escapeHtml(theme.surface);
  const borderColor = escapeHtml(theme.border);
  const accentColor = escapeHtml(theme.accent);
  const markerMetaJson = safeJson(markerMeta);
  const selectionMarksJson = safeJson(selectionMarks);
  const savedSpeechJson = safeJson([...savedSpeechTexts]);
  const actionLocksJson = safeJson(options);
  return `<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
  <style>
    html, body {
      margin: 0;
      padding: 0;
      background: ${bgColor};
      color: ${textColor};
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      -webkit-user-select: text;
      user-select: text;
    }
    #content .table-wrap {
      overflow-x: auto;
      margin: 8px 0;
    }
    #content table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    #content th, #content td {
      border: 1px solid ${borderColor};
      padding: 6px 8px;
      vertical-align: top;
    }
    #content th {
      background: ${surfaceColor};
    }
    #content pre {
      background: ${surfaceColor};
      border-radius: 8px;
      padding: 8px;
      overflow-x: auto;
      white-space: pre-wrap;
    }
    #content {
      white-space: normal;
      overflow-wrap: anywhere;
      border: 1px solid ${borderColor};
      border-radius: 10px;
      padding: 10px;
      font-size: 13px;
      line-height: 20px;
      min-height: 120px;
      box-sizing: border-box;
    }
    #content .md-block {
      margin: 0;
    }
    #content h1, #content h2, #content h3, #content p {
      margin: 0;
    }
    #content h1 {
      font-size: 14px;
      font-weight: 700;
      line-height: 22px;
    }
    #content h2 {
      font-size: 12px;
      font-weight: 700;
      line-height: 18px;
    }
    #content h3 {
      font-size: 13px;
      font-weight: 600;
      line-height: 20px;
    }
    #content p {
      font-size: 13px;
      line-height: 20px;
    }
    #content .md-blank {
      height: 4px;
    }
    .highlight-mark {
      border-radius: 3px;
      padding: 0 2px;
      color: #1f2937;
    }
    .annotation-mark {
      border-bottom: 1px dashed ${accentColor};
      cursor: pointer;
    }
    .annotation-mark::after {
      content: attr(data-badge);
      display: inline-block;
      margin-left: 2px;
      padding: 0 3px;
      border-radius: 999px;
      background: ${surfaceColor};
      color: ${accentColor};
      border: 1px solid ${borderColor};
      font-size: 9px;
      line-height: 13px;
      vertical-align: super;
      -webkit-user-select: none;
      user-select: none;
    }
    #toolbar {
      position: absolute;
      z-index: 20;
      display: none;
      align-items: center;
      gap: 6px;
      max-width: calc(100vw - 16px);
      padding: 6px;
      border: 1px solid ${borderColor};
      border-radius: 12px;
      background: ${surfaceColor};
      box-shadow: 0 8px 24px rgba(0,0,0,.28);
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
    #toolbar button {
      border: 0;
      border-radius: 8px;
      padding: 6px 8px;
      background: ${bgColor};
      color: ${accentColor};
      font-size: 12px;
      white-space: nowrap;
    }
    #toolbar button:disabled {
      opacity: .42;
    }
    #markerMenu {
      position: absolute;
      z-index: 30;
      display: none;
      flex-direction: column;
      gap: 4px;
      padding: 4px;
      border: 1px solid ${borderColor};
      border-radius: 10px;
      background: ${surfaceColor};
      box-shadow: 0 8px 24px rgba(0,0,0,.28);
    }
    #markerMenu button {
      border: 0;
      border-radius: 7px;
      padding: 6px 8px;
      background: ${bgColor};
      color: ${accentColor};
      font-size: 12px;
      text-align: left;
      white-space: nowrap;
    }
  </style>
</head>
<body>
  <div id="content">${body}</div>
  <div id="toolbar">
    <button data-action="highlight" onclick="runAction('highlight')">高亮</button>
    <button data-action="note" onclick="runAction('note')">笔记</button>
    <button data-action="elaboration" onclick="runAction('elaboration')">细化</button>
    <button data-action="edit" onclick="runAction('edit')">编辑</button>
    <button data-action="speech" onclick="runAction('speech')">话术</button>
  </div>
  <div id="markerMenu"></div>
  <script>
    const content = document.getElementById('content');
    const toolbar = document.getElementById('toolbar');
    const markerMenu = document.getElementById('markerMenu');
    const markerMeta = ${markerMetaJson};
    const selectionMarks = ${selectionMarksJson};
    const savedSpeeches = new Set(${savedSpeechJson});
    const actionLocks = ${actionLocksJson};
    let current = null;
    function post(payload) {
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    }
    function getTextOffsetBefore(container, targetNode, targetOffset) {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      let offset = 0;
      let current;
      while ((current = walker.nextNode())) {
        if (current === targetNode) return offset + targetOffset;
        offset += current.textContent ? current.textContent.length : 0;
      }
      return -1;
    }
    function getRangeStartOffset(container, range) {
      const startContainer = range.startContainer;
      const startOffset = range.startOffset;
      if (startContainer.nodeType === Node.TEXT_NODE) {
        return getTextOffsetBefore(container, startContainer, startOffset);
      }
      if (startContainer.nodeType === Node.ELEMENT_NODE) {
        const child = startContainer.childNodes[startOffset];
        if (child && child.nodeType === Node.TEXT_NODE) {
          return getTextOffsetBefore(container, child, 0);
        }
        if (child) {
          const walker = document.createTreeWalker(child, NodeFilter.SHOW_TEXT);
          const first = walker.nextNode();
          if (first) return getTextOffsetBefore(container, first, 0);
        }
      }
      return -1;
    }
    function selectionStartInContent(range) {
      const startNode =
        range.startContainer.nodeType === Node.ELEMENT_NODE
          ? range.startContainer
          : range.startContainer.parentElement;
      const block = startNode && startNode.closest ? startNode.closest('.md-block') : null;
      if (!block || !content.contains(block)) {
        const pre = range.cloneRange();
        pre.selectNodeContents(content);
        pre.setEnd(range.startContainer, range.startOffset);
        return pre.toString().length;
      }
      const mdStart = parseInt(block.getAttribute('data-md-start') || '0', 10);
      const mapRaw = block.getAttribute('data-visible-map');
      const map = mapRaw ? JSON.parse(mapRaw) : [];
      const offsetInBlock = getRangeStartOffset(block, range);
      if (offsetInBlock < 0) return mdStart;
      if (map.length > 0 && offsetInBlock < map.length && map[offsetInBlock] !== undefined) {
        return map[offsetInBlock];
      }
      return mdStart + offsetInBlock;
    }
    function hideToolbar() {
      toolbar.style.display = 'none';
      current = null;
      post({ type: 'clear' });
    }
    function hideMarkerMenu() {
      markerMenu.style.display = 'none';
      markerMenu.replaceChildren();
    }
    function button(action) {
      return toolbar.querySelector('[data-action="' + action + '"]');
    }
    function markExists(kind) {
      if (!current) return false;
      return selectionMarks.some((m) =>
        m.kind === kind &&
        m.text === current.text &&
        (m.start === current.start || m.start === undefined || m.start === null)
      );
    }
    function refreshToolbarState() {
      const noteDone = markExists('note');
      const elaborationDone = markExists('elaboration');
      const speechDone = current ? savedSpeeches.has(current.text.trim()) : false;
      const noteBtn = button('note');
      const elaborationBtn = button('elaboration');
      const speechBtn = button('speech');
      if (noteBtn) {
        noteBtn.textContent = noteDone ? '已有笔记' : '笔记';
        noteBtn.disabled = noteDone;
      }
      if (elaborationBtn) {
        const elaborationLocked = actionLocks.elaborationDisabled === true;
        elaborationBtn.textContent = elaborationDone ? '已细化' : elaborationLocked ? '细化忙碌' : '细化';
        elaborationBtn.disabled = elaborationDone || elaborationLocked;
      }
      if (speechBtn) {
        speechBtn.textContent = speechDone ? '已存话术' : '话术';
        speechBtn.disabled = speechDone;
      }
    }
    function updateHeight() {
      post({ type: 'height', height: Math.ceil(document.body.scrollHeight) });
    }
    function updateSelection() {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        hideToolbar();
        return;
      }
      const range = sel.getRangeAt(0);
      if (!content.contains(range.commonAncestorContainer)) {
        hideToolbar();
        return;
      }
      const raw = range.toString();
      const text = raw.trim();
      const leading = raw.search(/\\S/);
      if (!text || leading < 0) {
        hideToolbar();
        return;
      }
      const start = selectionStartInContent(range) + leading;
      current = { text, start };
      const rect = range.getBoundingClientRect();
      toolbar.style.display = 'flex';
      const top = Math.max(8, rect.top + window.scrollY - toolbar.offsetHeight - 8);
      const left = Math.min(Math.max(8, rect.left + window.scrollX), window.innerWidth - toolbar.offsetWidth - 8);
      toolbar.style.top = top + 'px';
      toolbar.style.left = left + 'px';
      post({ type: 'selection', text, start });
      refreshToolbarState();
      updateHeight();
    }
    function runAction(action) {
      if (!current) updateSelection();
      if (!current) return;
      const btn = button(action);
      if (btn && btn.disabled) return;
      post({ type: 'action', action, text: current.text, start: current.start });
    }
    function markerLabel(id) {
      return markerMeta[id]?.kind === 'note' ? '笔记' : '细化讲解';
    }
    function openMarkerMenu(event, idsText) {
      event.stopPropagation();
      const ids = idsText.split(' ').filter(Boolean);
      if (ids.length === 0) return;
      if (ids.length === 1) {
        post({ type: 'marker', id: ids[0] });
        return;
      }
      markerMenu.replaceChildren();
      for (const id of ids) {
        const item = document.createElement('button');
        item.type = 'button';
        item.textContent = markerLabel(id);
        item.onclick = function (e) {
          e.stopPropagation();
          hideMarkerMenu();
          post({ type: 'marker', id });
        };
        markerMenu.appendChild(item);
      }
      markerMenu.style.display = 'flex';
      markerMenu.style.left = Math.min(event.pageX, window.innerWidth - 140) + 'px';
      markerMenu.style.top = Math.min(event.pageY + 6, document.body.scrollHeight - 80) + 'px';
      updateHeight();
    }
    window.__clearSelection = function () {
      window.getSelection()?.removeAllRanges();
      hideToolbar();
      hideMarkerMenu();
      true;
    };
    document.addEventListener('click', (event) => {
      if (!markerMenu.contains(event.target)) hideMarkerMenu();
    });
    document.addEventListener('selectionchange', () => setTimeout(updateSelection, 0));
    document.addEventListener('mouseup', () => setTimeout(updateSelection, 0));
    document.addEventListener('touchend', () => setTimeout(updateSelection, 80));
    new ResizeObserver(updateHeight).observe(document.body);
    updateHeight();
  </script>
</body>
</html>`;
}

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
  const theme = useTheme();
  const webViewRef = useRef<WebView>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingMdRef = useRef<string | null>(null);
  const btnGhost = makeBtnGhost(theme);
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
  const [webHeight, setWebHeight] = useState(180);
  const [savedSpeechTexts, setSavedSpeechTexts] = useState<Set<string>>(() => new Set());

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
  const speechKey = `explain:speech:${nodeId}`;
  const deleteMarkKey = `explain:deleteMark:${nodeId}`;

  const { running: generating, error: loadError } = useTaskState(loadKey);
  const { running: regenerating, error: regenerateError } = useTaskState(regenerateKey);
  const { running: elaborating } = useTaskState(elaborateKey);
  const { running: savingFullEdit } = useTaskState(fullEditKey);
  const { running: savingHighlight } = useTaskState(highlightKey);
  const { running: clearingHighlight } = useTaskState(clearHighlightKey);
  const { running: savingNote } = useTaskState(noteKey);
  const { running: savingExcerpt } = useTaskState(excerptKey);
  const { running: savingSpeech } = useTaskState(speechKey);
  const { running: deletingMark } = useTaskState(deleteMarkKey);
  const runningGenerationCount = useRunningTaskCount(EXPLANATION_GENERATION_GROUP);
  const runningElaborationCount = useRunningTaskCount(EXPLANATION_ELABORATION_GROUP);
  const generationBlocked =
    runningGenerationCount >= MAX_PARALLEL_GENERATIONS && !generating && !regenerating;
  const elaborationBlocked =
    runningElaborationCount >= MAX_PARALLEL_ELABORATIONS && !elaborating;
  const busy =
    elaborating ||
    savingHighlight ||
    clearingHighlight ||
    savingNote ||
    savingExcerpt ||
    savingSpeech ||
    deletingMark;

  const regenerateTargetLabel = TIERS.find((t) => t.id === tier)?.label ?? tier;

  const bookmarked = annotations.some((a) => a.kind === 'bookmark');
  const highlightMarks = annotations.filter((a) => a.kind === 'highlight');
  const contentMarks = annotations.filter(
    (a) => a.kind === 'highlight' || a.kind === 'note' || a.kind === 'elaboration',
  );
  const markCount = contentMarks.length;

  const existingHighlight = useMemo(
    () =>
      phrase.trim()
        ? findHighlightMark(phrase, highlightMarks, selectionStart) ?? null
        : null,
    [phrase, highlightMarks, selectionStart],
  );

  // 笔记和细化都是「新增一条」：同一段做过就别再做，重复点只会攒出内容一样的多条
  const noteMark = phrase.trim()
    ? findMarkOnSelection(contentMarks, 'note', phrase, selectionStart)
    : undefined;
  const elaborationMark = phrase.trim()
    ? findMarkOnSelection(contentMarks, 'elaboration', phrase, selectionStart)
    : undefined;
  const selectionHtml = useMemo(
    () =>
      content
        ? buildSelectionHtml(content.contentMd, annotations, savedSpeechTexts, theme, {
            elaborationDisabled: elaborationBlocked,
          })
        : '',
    [annotations, content, elaborationBlocked, savedSpeechTexts, theme],
  );

  const loadAnnotations = useCallback((explanationId: string) => {
    setAnnotations(listAnnotations(getRawDb(), 'explanation', explanationId));
  }, []);

  const loadSavedSpeech = useCallback(() => {
    const rows = getRawDb().getAllSync<{ content_md: string }>(
      `SELECT content_md FROM speech_snippet WHERE source_type = 'node' AND source_id = ?`,
      nodeId,
    );
    setSavedSpeechTexts(new Set(rows.map((row) => row.content_md.trim()).filter(Boolean)));
  }, [nodeId]);

  const reloadPanelData = useCallback(() => {
    loadSavedSpeech();
    if (content) loadAnnotations(content.id);
  }, [content, loadAnnotations, loadSavedSpeech]);
  useLocalDataReload(reloadPanelData);

  const clearWebSelection = useCallback(() => {
    webViewRef.current?.injectJavaScript('window.__clearSelection && window.__clearSelection(); true;');
  }, []);

  const persistDraft = useCallback(
    (md: string, explanationId: string) => {
      const trimmed = md.trim();
      if (!trimmed) return;
      savingMdRef.current = md;
      void runTask(fullEditKey, '保存讲解', async () => {
        const result = await updateExplanation(getRawDb(), explanationId, trimmed);
        notifyDataChanged();
        return result;
      }).catch(() => undefined);
    },
    [fullEditKey, notifyDataChanged],
  );

  const flushSaveIfNeeded = useCallback(() => {
    if (!content || !editing) return;
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    if (draftMd === content.contentMd) return;
    const trimmed = draftMd.trim();
    if (!trimmed) return;
    persistDraft(draftMd, content.id);
  }, [content, editing, draftMd, persistDraft]);

  const scheduleSave = useCallback(() => {
    if (!content || !editing) return;
    if (draftMd === content.contentMd) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      saveTimeoutRef.current = null;
      flushSaveIfNeeded();
    }, 600);
  }, [content, editing, draftMd, flushSaveIfNeeded]);

  const flushSaveRef = useRef(flushSaveIfNeeded);
  useEffect(() => {
    // 渲染期不能写 ref（react-hooks/refs）。effect 按声明顺序执行，
    // 这条先于下方切换考点的 effect 运行，读到的一定是本轮最新回调。
    flushSaveRef.current = flushSaveIfNeeded;
  });

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    scheduleSave();
  }, [draftMd, scheduleSave]);

  const toggleEditing = useCallback(() => {
    if (!content) return;
    if (editing) {
      flushSaveIfNeeded();
      const trimmed = draftMd.trim();
      if (trimmed) {
        setContent((prev) => (prev ? { ...prev, contentMd: trimmed } : prev));
      }
      setEditing(false);
      return;
    }
    setDraftMd(content.contentMd);
    setEditing(true);
  }, [content, editing, draftMd, flushSaveIfNeeded]);

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

  // 换考点或档位时要一次做三件事：清掉选区与编辑态、用库里的缓存补内容、缓存没有才发起生成。
  // 前两件是同步 setState，但它们和第三件的发起动作绑在同一次切换上，拆开反而容易漏
  useEffect(() => {
    flushSaveRef.current();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPhrase('');
    setSelectionStart(undefined);
    setEditing(false);
    setModalMode(null);
    setModalDraft('');
    loadSavedSpeech();
    const cached = getExplanation(getRawDb(), nodeId, tier);
    if (cached?.contentMd) {
      adopt(cached);
      return;
    }
    setContent(null);
    if (generationBlocked) return;
    if (isTaskRunning(loadKey)) return;
    void runTask(
      loadKey,
      '生成讲解',
      async () => {
        const generated = await generateExplanation(getRawDb(), nodeId, tier);
        notifyDataChanged();
        return generated;
      },
      {
        group: EXPLANATION_GENERATION_GROUP,
        maxConcurrent: MAX_PARALLEL_GENERATIONS,
        limitMessage: '已有讲解生成任务进行中，请稍后再试',
      },
    ).catch(() => undefined);
  }, [nodeId, tier, loadKey, adopt, loadSavedSpeech, notifyDataChanged, generationBlocked]);

  const openModal = (mode: ActionModalMode): void => {
    // 重新生成和查看标记都不针对选区，其余动作没选中词句就无从下手
    if (!phrase.trim() && mode !== 'viewMarker' && mode !== 'regenerate') return;
    if (mode === 'highlight') {
      const existing = findHighlightMark(phrase, highlightMarks, selectionStart);
      setHighlightColor(existing?.highlightColor ?? DEFAULT_HIGHLIGHT_COLOR);
    }
    if (mode === 'edit') setModalDraft(phrase);
    if (mode === 'note' || mode === 'elaboration' || mode === 'regenerate') setModalDraft('');
    setModalMode(mode);
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
    if (mark.kind === 'note' || mark.kind === 'elaboration') {
      setViewMarker(mark);
      setModalMode('viewMarker');
    }
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

  const setSelectionFromWeb = (text: string, start: number): string => {
    const selected = text.trim();
    setPhrase(selected);
    setSelectionStart(
      content ? resolveSelectionStart(content.contentMd, text, start) : start,
    );
    return selected;
  };

  const openSelectionModal = (mode: ActionModalMode, text: string, start: number): void => {
    const selected = setSelectionFromWeb(text, start);
    if (!selected && mode !== 'viewMarker' && mode !== 'regenerate') return;
    if (mode === 'highlight') {
      const existing = findHighlightMark(selected, highlightMarks, start);
      setHighlightColor(existing?.highlightColor ?? DEFAULT_HIGHLIGHT_COLOR);
    }
    if (mode === 'edit') setModalDraft(selected);
    if (mode === 'note' || mode === 'elaboration' || mode === 'regenerate') setModalDraft('');
    setModalMode(mode);
  };

  const handleSelectionWebMessage = (event: WebViewMessageEvent): void => {
    let message: SelectionWebMessage;
    try {
      message = JSON.parse(event.nativeEvent.data) as SelectionWebMessage;
    } catch {
      return;
    }
    if (message.type === 'height') {
      setWebHeight(Math.max(140, message.height));
      return;
    }
    if (message.type === 'clear') {
      setPhrase('');
      setSelectionStart(undefined);
      return;
    }
    if (message.type === 'marker') {
      const mark = contentMarks.find((m) => m.id === message.id);
      if (mark) locateMark(mark);
      return;
    }
    if (message.type === 'selection') {
      setSelectionFromWeb(message.text, message.start);
      return;
    }
    if (message.action === 'speech') {
      setSelectionFromWeb(message.text, message.start);
      saveSpeech(message.text);
      return;
    }
    openSelectionModal(message.action, message.text, message.start);
  };

  const openRegenerate = (): void => {
    flushSaveIfNeeded();
    openModal('regenerate');
  };

  useTaskResult<Explanation>(fullEditKey, (result) => {
    const saved = savingMdRef.current;
    savingMdRef.current = null;
    setContent(result);
    setDraftMd((draft) => (saved !== null && draft === saved ? result.contentMd : draft));
    loadAnnotations(result.id);
  });

  // 这次的要求只拼进本次提示词，不落库：先取出来再收面板，避免清空 state 后拿到空串
  const submitRegenerate = (): void => {
    if (generationBlocked) return;
    const instruction = modalDraft.trim();
    setModalMode(null);
    setModalDraft('');
    void runTask(
      regenerateKey,
      '重新生成讲解',
      async () => {
        const generated = await generateExplanation(getRawDb(), nodeId, tier, instruction);
        notifyDataChanged();
        return generated;
      },
      {
        group: EXPLANATION_GENERATION_GROUP,
        maxConcurrent: MAX_PARALLEL_GENERATIONS,
        limitMessage: '已有讲解生成任务进行中，请稍后再试',
      },
    ).catch(() => undefined);
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
        clearWebSelection();
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
        clearWebSelection();
      })
      .catch(() => undefined);
  };

  const saveNote = (): void => {
    if (!content || !modalDraft.trim() || noteMark) return;
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
        ...(selectionStart !== undefined ? { selectionStart } : {}),
      });
      return '笔记已保存';
    })
      .then(() => {
        loadAnnotations(explanationId);
        setModalMode(null);
        setModalDraft('');
        clearWebSelection();
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
        clearWebSelection();
      })
      .catch(() => undefined);
  };

  const saveSpeech = (selectedText = phrase): void => {
    const text = selectedText.trim();
    if (!text) return;
    void runTask(speechKey, '存入话术库', async () => {
      const saved = await saveSpeechFromNode(getRawDb(), nodeId, text, tier);
      notifyDataChanged();
      return saved.existing ? '这段已经在话术库里' : '已存入话术库';
    })
      .then((message) => {
        Alert.alert('话术库', message);
        loadSavedSpeech();
        setPhrase('');
        setSelectionStart(undefined);
        clearWebSelection();
      })
      .catch(() => undefined);
  };

  const saveElaboration = (): void => {
    const text = phrase.trim();
    // 已细化过就别再请求模型：白花一次调用，落库那头也会当重复丢掉
    if (!text || !content || elaborationMark || elaborationBlocked) return;
    const target = { id: content.id, contentMd: content.contentMd };
    // 细化要请求模型，落库放在任务里：切走再回来，标记已经在正文上了
    void runTask(
      elaborateKey,
      '细化讲解',
      async () => {
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
          ...(selectionStart !== undefined ? { selectionStart } : {}),
        });
        return '细化讲解已保存';
      },
      {
        group: EXPLANATION_ELABORATION_GROUP,
        maxConcurrent: MAX_PARALLEL_ELABORATIONS,
        limitMessage: '已有细化讲解任务进行中，请稍后再试',
      },
    ).catch(() => undefined);
  };

  useTaskResult(elaborateKey, () => {
    const explanationId = content?.id ?? getExplanation(getRawDb(), nodeId, tier)?.id;
    if (explanationId) loadAnnotations(explanationId);
    setModalMode(null);
    clearWebSelection();
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
        clearWebSelection();
      })
      .catch(() => undefined);
  };

  if (!content && (generating || regenerating)) {
    return <Text style={{ color: theme.muted, fontSize: 13 }}>生成讲解中…</Text>;
  }

  if (!content && generationBlocked) {
    return <Text style={{ color: theme.muted, fontSize: 13 }}>已有讲解生成任务进行中，当前讲解会稍后自动开始…</Text>;
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
          <Text style={{ color: bookmarked ? theme.tone.amber.text : theme.muted, fontSize: 12 }}>
            {bookmarked ? '★ 已收藏' : '☆ 收藏'}
          </Text>
        </Pressable>
        {markCount > 0 && (
          <Pressable onPress={showMarkList} hitSlop={6}>
            <Text style={{ color: theme.accent, fontSize: 11 }}>{markCount} 条标记</Text>
          </Pressable>
        )}
        <Pressable onPress={toggleEditing} style={btnGhost}>
          <Text style={{ color: theme.accent, fontSize: 12 }}>
            {editing ? '阅读' : '编辑讲解'}
          </Text>
        </Pressable>
        <Pressable
          onPress={openRegenerate}
          disabled={regenerating || generationBlocked}
          style={btnGhost}
        >
          <Text style={{ color: theme.muted, fontSize: 12, opacity: regenerating || generationBlocked ? 0.5 : 1 }}>
            {regenerating ? '重新生成中…' : generationBlocked ? '生成忙碌' : '重新生成'}
          </Text>
        </Pressable>
        {editing && savingFullEdit && (
          <Text style={{ color: theme.muted, fontSize: 11 }}>保存中…</Text>
        )}
      </View>

      {editing ? (
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
      ) : (
        <>
          <WebView
            ref={webViewRef}
            originWhitelist={['*']}
            source={{ html: selectionHtml }}
            onMessage={handleSelectionWebMessage}
            scrollEnabled={false}
            hideKeyboardAccessoryView
            style={{
              height: webHeight,
              backgroundColor: theme.bg,
            }}
          />
        </>
      )}

      <ExplanationActionModal
        visible={modalMode !== null}
        mode={modalMode}
        phrase={phrase}
        draft={modalDraft}
        highlightColor={highlightColor}
        existingHighlight={existingHighlight}
        marker={viewMarker}
        busy={
          modalMode === 'regenerate'
            ? regenerating || generationBlocked
            : modalMode === 'elaboration'
              ? busy || elaborationBlocked
              : busy
        }
        regenerateHint={
          content.modelUsed === 'user-edit'
            ? `你手动修改过这份讲解，重新生成会覆盖当前「${regenerateTargetLabel}」的内容。`
            : `重新生成会覆盖当前「${regenerateTargetLabel}」的内容。`
        }
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
        onSubmitRegenerate={submitRegenerate}
        onDeleteMarker={deleteMarker}
      />
    </View>
  );
}

function makeBtnGhost(theme: Palette) {
  return {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: theme.bg,
  } as const;
}
