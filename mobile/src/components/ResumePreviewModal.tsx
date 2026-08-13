import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';
import type { ResumeDocument } from '@shared/resume/document';
import { buildResumeDocumentHtml } from '@shared/resume/renderHtml';
import type { ResumePreviewStyle } from '@shared/resume/previewStyle';
import { RESUME_TEMPLATES, RESUME_TEMPLATE_META } from '@shared/resume/templates';
import { theme } from '../theme';

/** A4 在 72 PPI 下的点数，expo-print 默认是美式 Letter，必须显式传 */
const A4_WIDTH_PT = 595;
const A4_HEIGHT_PT = 842;
/** 网页版式的纸张宽度，WebView 按它布局再整体缩放到屏幕宽 */
const PAGE_CSS_WIDTH = 794;

/** printToFileAsync 生成的是随机文件名，分享出去会变成乱码名，先改成可读的 */
function renameForShare(uri: string, fileStem: string): string {
  const safe = fileStem.replace(/[\\/:*?"<>|]/g, '').trim() || '简历';
  try {
    const generated = new File(uri);
    const target = new File(Paths.cache, `${safe}.pdf`);
    if (target.exists) target.delete();
    generated.move(target);
    return target.uri;
  } catch {
    return uri;
  }
}

export function ResumePreviewModal({
  resumeDocument,
  style,
  onStyleChange,
  meta,
  fileStem,
  onClose,
  onMessage,
}: {
  resumeDocument: ResumeDocument;
  style: ResumePreviewStyle;
  onStyleChange: (style: ResumePreviewStyle) => void;
  meta: { headline: string; subtitle?: string };
  fileStem: string;
  onClose: () => void;
  onMessage: (message: string) => void;
}): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const [exporting, setExporting] = useState(false);

  const previewHtml = buildResumeDocumentHtml(resumeDocument, style, {
    ...meta,
    viewportWidth: PAGE_CSS_WIDTH,
  });

  const exportPdf = async (): Promise<void> => {
    setExporting(true);
    try {
      const { uri } = await Print.printToFileAsync({
        html: buildResumeDocumentHtml(resumeDocument, style, meta),
        width: A4_WIDTH_PT,
        height: A4_HEIGHT_PT,
      });
      const fileUri = renameForShare(uri, fileStem);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(fileUri, {
          UTI: '.pdf',
          mimeType: 'application/pdf',
          dialogTitle: '导出简历 PDF',
        });
      } else {
        onMessage(`已生成 PDF：${fileUri}`);
      }
    } catch (e) {
      onMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
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
          <Text style={{ flex: 1, color: theme.text, fontSize: 15, fontWeight: '600' }} numberOfLines={1}>
            预览 · {RESUME_TEMPLATE_META[style.template].label}
          </Text>
          <Pressable
            onPress={() => void exportPdf()}
            disabled={exporting}
            style={{
              backgroundColor: theme.accent,
              borderRadius: 8,
              paddingHorizontal: 12,
              paddingVertical: 6,
              opacity: exporting ? 0.5 : 1,
            }}
          >
            <Text style={{ color: '#fff', fontSize: 12 }}>{exporting ? '导出中…' : '导出 PDF'}</Text>
          </Pressable>
          <Pressable onPress={onClose} style={{ paddingHorizontal: 8, paddingVertical: 6 }}>
            <Text style={{ color: theme.muted, fontSize: 12 }}>关闭</Text>
          </Pressable>
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0, borderBottomWidth: 1, borderBottomColor: theme.border, backgroundColor: theme.surface }}
          contentContainerStyle={{ gap: 6, paddingHorizontal: 14, paddingVertical: 8 }}
        >
          {RESUME_TEMPLATES.map((template) => {
            const active = template === style.template;
            return (
              <Pressable
                key={template}
                onPress={() => onStyleChange({ ...style, template })}
                style={{
                  borderWidth: 1,
                  borderColor: active ? theme.accent : theme.border,
                  backgroundColor: active ? `${theme.accent}22` : theme.bg,
                  borderRadius: 999,
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                }}
              >
                <Text style={{ color: active ? theme.text : theme.muted, fontSize: 12 }}>
                  {RESUME_TEMPLATE_META[template].label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <WebView
          originWhitelist={['*']}
          source={{ html: previewHtml }}
          javaScriptEnabled={false}
          style={{ flex: 1, backgroundColor: '#fff' }}
        />

        <Text
          style={{
            color: theme.muted,
            fontSize: 11,
            paddingHorizontal: 14,
            paddingTop: 8,
            paddingBottom: insets.bottom + 8,
            backgroundColor: theme.surface,
          }}
        >
          {RESUME_TEMPLATE_META[style.template].hint}
        </Text>
      </View>
    </Modal>
  );
}
