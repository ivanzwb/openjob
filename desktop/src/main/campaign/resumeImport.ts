import { dialog } from 'electron';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import mammoth from 'mammoth';
import WordExtractor from 'word-extractor';
import type { ResumeImportResult } from '@core/ipc';
import { structureResumeWithLlm } from '../resume/ai';
import { createResume } from './repository';

const SUPPORTED_EXTENSIONS = ['pdf', 'doc', 'docx', 'txt', 'md'];

/**
 * 在加载 pdf-parse 之前确保全局存在 DOMMatrix 构造器。
 *
 * pdf-parse → pdfjs-dist 的 legacy 构建在模块顶层执行 `new DOMMatrix()`
 * （pdf.mjs:15620 SCALE_MATRIX），Node/Electron 主进程没有 DOM API，
 * 缺了它会直接 ReferenceError。官方 polyfill 依赖 @napi-rs/canvas 的原生绑定，
 * 但打包后原生绑定在 asar.unpacked / 平台包里，polyfill 落空就会抛
 * "ReferenceError: DOMMatrix is not defined"。
 * 这里优先用 @napi-rs/canvas 的原生实现，拿不到（打包缺绑定）时退回
 * @napi-rs/canvas/geometry（纯 JS 的 geometry-polyfill，deps 为空的 Node 内建 util，
 * dev / 打包一致可用），在导入 PDF 解析器之前把 DOMMatrix 先装到 globalThis 上。
 */
async function ensureDOMMatrix(): Promise<void> {
  if (typeof globalThis.DOMMatrix !== 'undefined') return;

  try {
    const canvas = await import('@napi-rs/canvas');
    if (canvas.DOMMatrix) {
      globalThis.DOMMatrix = canvas.DOMMatrix;
      return;
    }
  } catch {
    // 打包环境缺原生绑定（.node 未随包分发），退回纯 JS 实现
  }

  // @napi-rs/canvas 无 exports 字段，Node ESM 要求带 .js 后缀才能解析子路径
  const geometry = await import('@napi-rs/canvas/geometry.js');
  if (!geometry.DOMMatrix) {
    throw new Error('无法加载 DOMMatrix polyfill（@napi-rs/canvas/geometry.js 未导出 DOMMatrix）');
  }
  globalThis.DOMMatrix = geometry.DOMMatrix;
}

/** 从简历文件中提取纯文本（pdf 走 pdf-parse，docx 走 mammoth，其余按 utf-8 读取） */
async function extractResumeText(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase().replace(/^\./, '');
  const buffer = await readFile(filePath);

  if (ext === 'pdf') {
    // pdf-parse 顶层会 new DOMMatrix()，必须先把 polyfill 装上（见 ensureDOMMatrix 注释）
    await ensureDOMMatrix();
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text ?? '';
    } finally {
      await parser.destroy();
    }
  }

  if (ext === 'docx') {
    const result = await mammoth.extractRawText({ buffer });
    return result.value ?? '';
  }

  if (ext === 'doc') {
    const doc = await new WordExtractor().extract(buffer);
    return [doc.getBody(), doc.getTextboxes({ includeHeadersAndFooters: false })]
      .map((part) => part.trim())
      .filter(Boolean)
      .join('\n\n');
  }

  if (ext === 'txt' || ext === 'md') {
    return buffer.toString('utf8');
  }

  throw new Error(`不支持的简历文件格式：.${ext || 'unknown'}`);
}

/**
 * 弹出文件选择框导入简历：
 * 取消返回 null，提取失败抛错（由 IPC 层转为错误返回）。
 * 导入成功后直接写入简历库，可被任意 Campaign 复用。
 */
export async function importResumeFromFile(): Promise<ResumeImportResult | null> {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '导入简历',
    properties: ['openFile'],
    filters: [
      { name: '简历文件', extensions: SUPPORTED_EXTENSIONS },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (canceled || filePaths.length === 0) return null;

  const filePath = filePaths[0];
  const rawText = (await extractResumeText(filePath)).trim();
  if (rawText.length < 10) {
    throw new Error('未能从该文件中提取到简历文本，请确认内容有效（暂不支持扫描件 PDF）');
  }
  const label = basename(filePath, extname(filePath));
  // 纯文本先用模型归类成固定模块，模型不可用时退回规则识别（返回里带 fallbackReason）
  const structured = await structureResumeWithLlm(rawText);
  return { ...createResume(label, structured.contentMd), fallbackReason: structured.fallbackReason };
}
