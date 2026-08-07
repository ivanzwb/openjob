import { writeFileSync } from 'node:fs';
import { BrowserWindow } from 'electron';
import type { SpeechSnippetView } from '@shared/ipc';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildSpeechHtml(snippets: SpeechSnippetView[]): string {
  const sections = snippets
    .map(
      (s) => `
    <section class="snippet">
      <h2>${escapeHtml(s.sourceLabel)}</h2>
      <pre>${escapeHtml(s.contentMd)}</pre>
    </section>`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>openJob 话术库</title>
  <style>
    body { font-family: "Segoe UI", system-ui, sans-serif; margin: 40px; color: #111; line-height: 1.6; }
    h1 { font-size: 22px; margin-bottom: 8px; }
    .meta { color: #666; font-size: 12px; margin-bottom: 32px; }
    h2 { font-size: 15px; margin: 24px 0 8px; color: #0f766e; }
    pre { white-space: pre-wrap; font-size: 13px; background: #f8fafc; padding: 12px; border-radius: 8px; border: 1px solid #e2e8f0; }
    .snippet { page-break-inside: avoid; margin-bottom: 24px; }
  </style>
</head>
<body>
  <h1>openJob 话术库</h1>
  <p class="meta">导出时间：${escapeHtml(new Date().toLocaleString())} · 共 ${snippets.length} 条</p>
  ${sections}
</body>
</html>`;
}

export async function writeSpeechPdf(snippets: SpeechSnippetView[], filePath: string): Promise<void> {
  const html = buildSpeechHtml(snippets);
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true },
  });

  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
    });
    writeFileSync(filePath, pdf);
  } finally {
    win.destroy();
  }
}
