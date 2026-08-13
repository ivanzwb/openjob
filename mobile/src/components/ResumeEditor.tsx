import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { ResumeDocument, ResumeSectionKey } from '@shared/resume/document';
import {
  RESUME_SECTION_CATALOG,
  catalogHintForKey,
  documentToMarkdown,
  parseMarkdownToDocument,
} from '@shared/resume/document';
import { parsePreviewStyle, serializePreviewStyle, type ResumePreviewStyle } from '@shared/resume/previewStyle';
import { getRawDb } from '../db';
import { updateResumeEntry, type ResumeEntry } from '../data/resumeLocal';
import { polishResume, structureResume } from '../data/resumeAi';
import { useApp } from '../context/AppContext';
import { useRemoteTask } from '../context/RemoteTaskContext';
import { theme } from '../theme';
import { ResumeSectionForm, type SectionPolish } from './ResumeSectionForm';
import { ResumePreviewModal } from './ResumePreviewModal';

/** 手机上边打字边写库太吵，比桌面更钝一些，切后台与退出时补一次 */
const AUTO_SAVE_DELAY = 1500;

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const STATUS_TEXT: Record<SaveStatus, string> = {
  idle: '',
  saving: '保存中…',
  saved: '已自动保存',
  error: '保存失败，继续编辑会重试',
};

export function ResumeEditor({
  entry,
  onBack,
}: {
  entry: ResumeEntry;
  onBack: () => void;
}): React.JSX.Element {
  const { triggerSync, notifyDataChanged } = useApp();
  const { runTask } = useRemoteTask();

  const [doc, setDoc] = useState<ResumeDocument>(() => parseMarkdownToDocument(entry.contentMd));
  const [label, setLabel] = useState(entry.label);
  const [style, setStyle] = useState<ResumePreviewStyle>(() => parsePreviewStyle(entry.previewStyle));
  const [activeKey, setActiveKey] = useState<ResumeSectionKey>('basic');
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [previewOpen, setPreviewOpen] = useState(false);
  /** AI 识别会整体换掉正文，用它强制重建表单的本地状态 */
  const [formNonce, setFormNonce] = useState(0);

  const contentMd = useMemo(() => documentToMarkdown(doc), [doc]);
  // 基线取序列化后的正文：解析会顺手规范化格式，直接拿库里的原文比会白存一次
  const [baseline] = useState(() => ({ contentMd: documentToMarkdown(doc), label: entry.label }));
  const savedRef = useRef(baseline);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{ contentMd: string; label: string } | null>(null);

  const persist = useCallback(
    async (next: { contentMd: string; label: string }) => {
      setStatus('saving');
      try {
        await updateResumeEntry(getRawDb(), entry.kind, entry.id, {
          contentMd: next.contentMd,
          ...(entry.kind === 'resume' ? { label: next.label } : {}),
        });
        savedRef.current = next;
        notifyDataChanged();
        setStatus('saved');
      } catch {
        // 失败不立刻重试，等下一次编辑再写，避免在错误上打转
        savedRef.current = next;
        setStatus('error');
      }
      // 存的过程中又有新输入时，待写内容已被换成更新的一份，不能清掉
      if (pendingRef.current === next) pendingRef.current = null;
    },
    [entry.id, entry.kind, notifyDataChanged],
  );

  useEffect(() => {
    const next = { contentMd, label };
    if (next.contentMd === savedRef.current.contentMd && next.label === savedRef.current.label) {
      return;
    }
    pendingRef.current = next;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void persist(next), AUTO_SAVE_DELAY);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [contentMd, label, persist]);

  const flush = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    void persist(pending);
  }, [persist]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') flush();
    });
    return () => sub.remove();
  }, [flush]);

  // 退出编辑器时补写未保存的内容，并把这次编辑推给桌面。
  // 自动保存只写本地，避免每敲几个字就发一次网络请求。
  const exitRef = useRef({ persist, triggerSync });
  useEffect(() => {
    exitRef.current = { persist, triggerSync };
  });
  useEffect(
    () => () => {
      const pending = pendingRef.current;
      if (timerRef.current) clearTimeout(timerRef.current);
      void (async () => {
        if (pending) await exitRef.current.persist(pending);
        await exitRef.current.triggerSync().catch(() => undefined);
      })();
    },
    [],
  );

  const setSectionContent = (key: ResumeSectionKey, value: string): void => {
    setDoc((prev) => ({
      sections: prev.sections.map((s) => (s.key === key ? { ...s, contentMd: value } : s)),
    }));
  };

  const changeStyle = (next: ResumePreviewStyle): void => {
    setStyle(next);
    void (async () => {
      try {
        await updateResumeEntry(getRawDb(), entry.kind, entry.id, {
          previewStyle: serializePreviewStyle(next),
        });
        notifyDataChanged();
      } catch {
        // 模板只影响排版，写失败不打断编辑
      }
    })();
  };

  const polish: SectionPolish = async ({ contentMd: sectionMd, instruction, scopeLabel }) =>
    polishResume({
      resumeMd: contentMd,
      sectionKey: activeKey,
      scopeLabel,
      contentMd: sectionMd,
      instruction,
    });

  const runStructure = (): void => {
    if (!contentMd.trim()) {
      Alert.alert('AI 识别', '简历还没有内容');
      return;
    }
    Alert.alert('AI 识别', '让模型把现有内容重新归类到固定模块，只归类不改写。', [
      { text: '取消', style: 'cancel' },
      {
        text: '开始',
        onPress: () => {
          void (async () => {
            try {
              const md = await runTask('AI 识别', async () => structureResume(contentMd));
              setDoc(parseMarkdownToDocument(md));
              setFormNonce((n) => n + 1);
            } catch {
              // toast handled by runTask
            }
          })();
        },
      },
    ]);
  };

  const activeSection = doc.sections.find((s) => s.key === activeKey) ?? doc.sections[0];

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Pressable onPress={onBack} style={{ paddingVertical: 4, paddingRight: 6 }}>
            <Text style={{ color: theme.accent, fontSize: 13 }}>‹ 返回</Text>
          </Pressable>
          {entry.kind === 'resume' ? (
            <TextInput
              value={label}
              onChangeText={setLabel}
              placeholder="简历名称"
              placeholderTextColor={theme.muted}
              style={{
                flex: 1,
                color: theme.text,
                fontSize: 14,
                fontWeight: '600',
                borderWidth: 1,
                borderColor: theme.border,
                borderRadius: 8,
                paddingHorizontal: 10,
                paddingVertical: 6,
                backgroundColor: theme.surface,
              }}
            />
          ) : (
            <Text style={{ flex: 1, color: theme.text, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>
              {entry.label}
            </Text>
          )}
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ flex: 1, color: status === 'error' ? theme.danger : theme.muted, fontSize: 11 }}>
            {STATUS_TEXT[status]}
          </Text>
          <Pressable
            onPress={runStructure}
            style={{
              borderWidth: 1,
              borderColor: theme.border,
              borderRadius: 8,
              paddingHorizontal: 10,
              paddingVertical: 6,
            }}
          >
            <Text style={{ color: theme.muted, fontSize: 12 }}>AI 识别</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              flush();
              setPreviewOpen(true);
            }}
            style={{
              backgroundColor: theme.accent,
              borderRadius: 8,
              paddingHorizontal: 12,
              paddingVertical: 6,
            }}
          >
            <Text style={{ color: '#fff', fontSize: 12 }}>预览 / 导出</Text>
          </Pressable>
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0 }}
          contentContainerStyle={{ gap: 6, paddingVertical: 2 }}
        >
          {RESUME_SECTION_CATALOG.map((item) => {
            const section = doc.sections.find((s) => s.key === item.key);
            const filled = Boolean(section?.contentMd.trim());
            const active = item.key === activeKey;
            return (
              <Pressable
                key={item.key}
                onPress={() => setActiveKey(item.key)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  borderWidth: 1,
                  borderColor: active ? theme.accent : theme.border,
                  backgroundColor: active ? `${theme.accent}22` : theme.surface,
                  borderRadius: 999,
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                }}
              >
                <View
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: filled ? theme.success : theme.border,
                  }}
                />
                <Text style={{ color: active ? theme.text : theme.muted, fontSize: 12 }}>{item.title}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 12 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={{ color: theme.muted, fontSize: 11, lineHeight: 16 }}>
          {catalogHintForKey(activeSection.key)}
        </Text>
        <ResumeSectionForm
          key={`${activeSection.key}-${formNonce}`}
          section={activeSection}
          polish={polish}
          onContentChange={(value) => setSectionContent(activeSection.key, value)}
        />
      </ScrollView>

      {previewOpen && (
        <ResumePreviewModal
          resumeDocument={doc}
          style={style}
          onStyleChange={changeStyle}
          meta={{ headline: entry.kind === 'resume' ? label : entry.headline }}
          fileStem={entry.fileStem}
          onClose={() => setPreviewOpen(false)}
          onMessage={(message) => Alert.alert('导出 PDF', message)}
        />
      )}
    </View>
  );
}
