import { dialog } from 'electron';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import type { Resume } from '@shared/entities';
import { createResume } from './repository';

const SUPPORTED_EXTENSIONS = ['pdf', 'docx', 'txt', 'md'];

/** 从简历文件中提取纯文本（pdf 走 pdf-parse，docx 走 mammoth，其余按 utf-8 读取） */
async function extractResumeText(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase().replace(/^\./, '');
  const buffer = await readFile(filePath);

  if (ext === 'pdf') {
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

  // txt / md 等纯文本格式
  return buffer.toString('utf8');
}

/**
 * 弹出文件选择框导入简历：
 * 取消返回 null，提取失败抛错（由 IPC 层转为错误返回）。
 * 导入成功后直接写入简历库，可被任意 Campaign 复用。
 */
export async function importResumeFromFile(): Promise<Resume | null> {
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
  return createResume(label, rawText);
}
