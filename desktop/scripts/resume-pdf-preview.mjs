import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, nativeImage } from 'electron';
import { PDFParse } from 'pdf-parse';

/**
 * 简历版式自检：把简历 HTML 按导出同款参数打成 PDF，再把每页渲染成 PNG，
 * 用来肉眼核对页边距、分页位置和顶栏色块的出血效果。
 *
 * 用法：
 *   npx electron scripts/resume-pdf-preview.mjs [html 目录]
 * 目录默认取 out/tmp/resume，产物（pdf / png）落在同一目录下。
 * 待检的 HTML 自己准备：用 npx tsx 调 shared/resume 的 buildResumeDocumentHtml 落盘即可。
 *
 * printToPDF 的参数必须和 src/main/resume/pdf.ts 保持一致，否则自检结果没有意义。
 */

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workDir = resolve(process.argv[2] ?? join(projectRoot, 'out', 'tmp', 'resume'));
mkdirSync(workDir, { recursive: true });

/** 非分页预览（桌面弹窗 / 模板选择器 / 移动端 WebView）的纸张宽度 */
const PAGE_CSS_WIDTH = 794;
/** 每页 PNG 顶部裁切高度，够看清上边距和第一行正文 */
const TOP_CROP_HEIGHT = 420;

async function exportPdf(win, htmlFile, pdfFile) {
  await win.loadFile(htmlFile);
  const pdf = await win.webContents.printToPDF({
    printBackground: true,
    pageSize: 'A4',
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
  });
  writeFileSync(pdfFile, pdf);
  return pdf;
}

/** 顺带截一张非分页渲染的截图：三处预览走的是同一份 HTML，改动不能让它丢留白 */
async function capturePreview(win, htmlFile, prefix) {
  await win.loadFile(htmlFile);
  win.setContentSize(PAGE_CSS_WIDTH, 900);
  await win.webContents.executeJavaScript('window.scrollTo(0, 0)');
  writeFileSync(`${prefix}-preview-top.png`, (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(
    'window.scrollTo(0, document.documentElement.scrollHeight)',
  );
  writeFileSync(`${prefix}-preview-bottom.png`, (await win.webContents.capturePage()).toPNG());
}

/** 把 PDF 每页渲染成整页 PNG，并额外裁一张页面顶部，方便直接比对上边距 */
async function rasterize(pdfBuffer, prefix) {
  const parser = new PDFParse({ data: pdfBuffer });
  try {
    const shots = await parser.getScreenshot({ scale: 1.5, imageBuffer: true });
    for (const page of shots.pages) {
      const fullPath = `${prefix}-p${page.pageNumber}.png`;
      writeFileSync(fullPath, page.data);

      const full = nativeImage.createFromPath(fullPath);
      const { width, height } = full.getSize();
      const top = full.crop({ x: 0, y: 0, width, height: Math.min(TOP_CROP_HEIGHT, height) });
      writeFileSync(`${prefix}-p${page.pageNumber}-top.png`, top.toPNG());
    }
    return shots.pages.length;
  } finally {
    await parser.destroy();
  }
}

app.whenReady().then(async () => {
  const htmlFiles = readdirSync(workDir).filter((f) => f.endsWith('.html'));
  if (htmlFiles.length === 0) {
    console.error(`[resume-pdf-preview] ${workDir} 下没有 html，先生成简历 HTML 再跑`);
    process.exit(1);
  }

  // 复用同一个窗口：连续新建 / destroy 窗口时 loadFile 偶发 ERR_FAILED
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  for (const file of htmlFiles) {
    const name = basename(file, '.html');
    const prefix = join(workDir, name);
    try {
      const pdf = await exportPdf(win, join(workDir, file), `${prefix}.pdf`);
      await capturePreview(win, join(workDir, file), prefix);
      const pages = await rasterize(pdf, prefix);
      console.log(`[resume-pdf-preview] ${name}：${pages} 页，PDF 与 PNG 已写入 ${workDir}`);
    } catch (err) {
      console.error(`[resume-pdf-preview] ${name}：失败 ${err.message || err}`);
    }
  }
  win.destroy();
  process.exit(0);
});
