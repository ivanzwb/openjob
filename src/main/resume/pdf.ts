import { writeFileSync } from 'node:fs';
import { dialog } from 'electron';
import { BrowserWindow } from 'electron';
import type { ResumePdfTemplate } from '@shared/resume/templates';
import type { ResumeVariantView } from '@shared/ipc';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function markdownToSimpleHtml(md: string): string {
  const lines = md.split('\n');
  const parts: string[] = [];
  let inList = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('## ')) {
      if (inList) {
        parts.push('</ul>');
        inList = false;
      }
      parts.push(`<h2>${escapeHtml(trimmed.slice(3))}</h2>`);
      continue;
    }
    if (trimmed.startsWith('- ')) {
      if (!inList) {
        parts.push('<ul>');
        inList = true;
      }
      parts.push(`<li>${escapeHtml(trimmed.slice(2))}</li>`);
      continue;
    }
    if (inList) {
      parts.push('</ul>');
      inList = false;
    }
    if (!trimmed) {
      parts.push('<br/>');
      continue;
    }
    parts.push(`<p>${escapeHtml(trimmed)}</p>`);
  }
  if (inList) parts.push('</ul>');
  return parts.join('\n');
}

const BASE_CSS = `
  body { font-family: "Segoe UI", "PingFang SC", system-ui, sans-serif; color: #111; line-height: 1.55; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .meta { color: #64748b; font-size: 12px; margin-bottom: 24px; }
  h2 { font-size: 14px; margin: 18px 0 8px; color: #0f766e; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
  p { margin: 6px 0; font-size: 13px; }
  ul { margin: 6px 0 10px 18px; font-size: 13px; }
  li { margin: 4px 0; }
`;

const TEMPLATE_CSS: Record<ResumePdfTemplate, string> = {
  classic: `${BASE_CSS} body { margin: 40px; max-width: 720px; }`,
  modern: `${BASE_CSS} body { margin: 48px 56px; max-width: 680px; } h1 { font-weight: 300; letter-spacing: 0.02em; } h2 { color: #0369a1; border: none; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; }`,
  compact: `${BASE_CSS} body { margin: 28px 32px; font-size: 12px; } h1 { font-size: 18px; } h2 { font-size: 12px; margin-top: 12px; } p, ul { font-size: 11px; }`,
};

export function buildResumeHtml(variant: ResumeVariantView, template: ResumePdfTemplate): string {
  const bodyHtml = markdownToSimpleHtml(variant.contentMd);
  const footer = `针对 ${variant.company} · ${variant.roleTitle} · 导出 ${new Date().toLocaleString()}`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(variant.label)}</title>
  <style>${TEMPLATE_CSS[template]}</style>
</head>
<body>
  <h1>${escapeHtml(variant.label)}</h1>
  <p class="meta">${escapeHtml(footer)}</p>
  ${bodyHtml}
</body>
</html>`;
}

export async function writeResumePdf(html: string, filePath: string): Promise<void> {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      margins: { top: 0.4, bottom: 0.4, left: 0.5, right: 0.5 },
    });
    writeFileSync(filePath, pdf);
  } finally {
    win.destroy();
  }
}

export async function exportResumeVariantPdf(
  variant: ResumeVariantView,
  template: ResumePdfTemplate,
): Promise<{ saved: boolean; path: string | null }> {
  const filePath = dialog.showSaveDialogSync({
    defaultPath: `OpenJob-Resume-${variant.company}-${variant.roleTitle}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (!filePath) return { saved: false, path: null };

  const html = buildResumeHtml(variant, template);
  await writeResumePdf(html, filePath);
  return { saved: true, path: filePath };
}
