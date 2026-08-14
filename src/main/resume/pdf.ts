import { writeFileSync } from 'node:fs';
import { dialog, BrowserWindow } from 'electron';
import { parseMarkdownToDocument } from '@shared/resume/document';
import { parsePreviewStyle } from '@shared/resume/previewStyle';
import { buildResumeDocumentHtml } from '@shared/resume/renderHtml';
import type { ResumeExportInput, ResumeExportResult } from '@shared/ipc';

export function buildResumeHtml(input: ResumeExportInput): string {
  const style = parsePreviewStyle(input.previewStyle);
  const doc = parseMarkdownToDocument(input.contentMd);
  return buildResumeDocumentHtml(doc, style, {
    headline: input.headline,
    subtitle: input.subtitle,
    photo: input.photo,
  });
}

export async function writeResumePdf(html: string, filePath: string): Promise<void> {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      // 实测这里的 margins 只在 CSS 没写 @page margin 时才生效；页边距一律交给模板 CSS 的
      // @page 决定，续页才能有上下留白、首页顶栏色块才能出血到纸张边缘。归零是兜底。
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    writeFileSync(filePath, pdf);
  } finally {
    win.destroy();
  }
}

/** 母版与优化版共用：正文与样式由渲染进程传入，保证导出与预览一致 */
export async function exportResumePdf(input: ResumeExportInput): Promise<ResumeExportResult> {
  const stem = input.fileStem.replace(/[\\/:*?"<>|]/g, '_').trim() || 'OpenJob-Resume';
  const filePath = dialog.showSaveDialogSync({
    defaultPath: `${stem}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (!filePath) return { saved: false, path: null };

  await writeResumePdf(buildResumeHtml(input), filePath);
  return { saved: true, path: filePath };
}
