import { Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import * as Print from 'expo-print';
import type { SpeechSnippetView } from '@shared/ipc';
import { runTask, useTaskState } from '../context/RemoteTaskContext';
import { markdownToDisplayHtml } from '../lib/markdownDisplay';
import { useTheme } from '../theme';

const TIER_LABEL: Record<SpeechSnippetView['tier'], string> = {
  oneliner: '一句话',
  spoken: '口语稿',
  deep: '深挖',
};

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildSpeechLibraryHtml(items: SpeechSnippetView[]): string {
  const sections = items
    .map((item, index) => {
      const content = markdownToDisplayHtml(item.contentMd) || '（空）';
      return `
        <section class="snippet">
          <div class="index">${index + 1}</div>
          <div class="body">
            <h2>${escapeHtml(item.sourceLabel)}</h2>
            <div class="meta">${TIER_LABEL[item.tier]}${item.isUserEdited ? ' · 已改写' : ''}</div>
            <div class="content">${content}</div>
          </div>
        </section>
      `;
    })
    .join('');

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      @page { size: A4; margin: 18mm 16mm; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        color: #1f2937;
        background: #fff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
          "Microsoft YaHei", sans-serif;
        font-size: 12px;
        line-height: 1.7;
      }
      header { margin-bottom: 24px; border-bottom: 2px solid #111827; padding-bottom: 12px; }
      h1 { margin: 0; font-size: 24px; }
      .summary { margin-top: 4px; color: #6b7280; }
      .snippet {
        display: flex;
        gap: 12px;
        padding: 16px 0;
        border-bottom: 1px solid #e5e7eb;
        break-inside: avoid;
        page-break-inside: avoid;
      }
      .index {
        width: 24px;
        height: 24px;
        flex: 0 0 24px;
        border-radius: 12px;
        background: #111827;
        color: #fff;
        text-align: center;
        line-height: 24px;
        font-weight: 700;
      }
      .body { min-width: 0; flex: 1; }
      h2 { margin: 0; font-size: 15px; line-height: 1.4; }
      .meta { margin: 3px 0 8px; color: #6b7280; font-size: 10px; }
      .content { white-space: normal; }
      .content .md-blank { height: 4px; }
      .content h1 { margin: 0; font-size: 14px; font-weight: 700; line-height: 22px; }
      .content h2 { margin: 0; font-size: 12px; font-weight: 700; line-height: 18px; }
      .content h3 { margin: 0; font-size: 13px; font-weight: 600; line-height: 20px; }
      .content p { margin: 0; font-size: 13px; line-height: 20px; }
      .content .table-wrap { overflow-x: auto; margin: 8px 0; }
      .content table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }
      .content th, .content td {
        border: 1px solid #e5e7eb;
        padding: 6px 8px;
        vertical-align: top;
      }
      .content th { background: #f3f4f6; }
      .content pre {
        background: #f3f4f6;
        border-radius: 8px;
        padding: 8px;
        overflow-x: auto;
        white-space: pre-wrap;
      }
      .content code { font-family: ui-monospace, monospace; font-size: 11px; }
    </style>
  </head>
  <body>
    <header>
      <h1>OpenJob 话术库</h1>
      <div class="summary">共 ${items.length} 条 · 整体复习稿</div>
    </header>
    ${sections}
  </body>
</html>`;
}

export function SpeechLibraryPreviewModal({
  items,
  onClose,
}: {
  items: SpeechSnippetView[];
  onClose: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const taskKey = 'speech:print:all';
  const { running: printing } = useTaskState(taskKey);
  const html = buildSpeechLibraryHtml(items);

  const printAll = (): void => {
    void runTask(
      taskKey,
      '打印话术库',
      async () => {
        await Print.printAsync({ html, orientation: Print.Orientation.portrait });
        return '已打开打印窗口';
      },
      { toastSuccess: false },
    ).catch(() => undefined);
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: theme.bg }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingHorizontal: 14,
            paddingTop: insets.top + 10,
            paddingBottom: 10,
            borderBottomWidth: 1,
            borderBottomColor: theme.border,
            backgroundColor: theme.surface,
          }}
        >
          <View style={{ flex: 1 }}>
            <Text style={{ color: theme.text, fontSize: 15, fontWeight: '600' }}>话术库整体预览</Text>
            <Text style={{ color: theme.muted, fontSize: 10 }}>共 {items.length} 条</Text>
          </View>
          <Pressable
            onPress={printAll}
            disabled={printing || items.length === 0}
            style={{
              backgroundColor: theme.accent,
              borderRadius: 8,
              paddingHorizontal: 12,
              paddingVertical: 7,
              opacity: printing || items.length === 0 ? 0.5 : 1,
            }}
          >
            <Text style={{ color: '#fff', fontSize: 12 }}>
              {printing ? '打印中…' : '打印全部'}
            </Text>
          </Pressable>
          <Pressable onPress={onClose} style={{ paddingHorizontal: 8, paddingVertical: 7 }}>
            <Text style={{ color: theme.muted, fontSize: 12 }}>关闭</Text>
          </Pressable>
        </View>
        <WebView
          originWhitelist={['*']}
          source={{ html }}
          javaScriptEnabled={false}
          style={{ flex: 1, backgroundColor: '#fff' }}
        />
      </View>
    </Modal>
  );
}
