import { Directory, File, Paths } from 'expo-file-system';

/** whisper.cpp 多语言模型（支持中文），q5_1 量化：体积/质量折中 */
export const WHISPER_MODEL = {
  /** 模型文件名，与 HF 仓库一致 */
  name: 'ggml-base-q5_1.bin',
  /** 原始 HF 直链 */
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin',
  /** 体积约 56.9MB */
  sizeBytes: 56.9 * 1024 * 1024,
} as const;

export interface ModelProgress {
  /** 0-100 */
  percent: number;
  /** 已下载字节 */
  bytesWritten: number;
  /** 总字节 */
  totalBytes: number;
}

/** 模型文件所在目录：document 下，系统清理缓存不会误删 */
function modelDir(): Directory {
  return new Directory(Paths.document, 'stt-models');
}

/** 模型文件路径（可能不存在） */
export function modelFile(): File {
  return new File(modelDir(), WHISPER_MODEL.name);
}

/** 模型是否已就绪（文件存在且非空） */
export function isModelReady(): boolean {
  const file = modelFile();
  return file.exists && file.size > 0;
}

/**
 * 确保模型可用：已缓存则直接返回，否则走 gh-proxy 镜像下载。
 * 带进度回调（百分比）。
 */
export async function ensureModel(
  onProgress?: (progress: ModelProgress) => void,
): Promise<File> {
  const file = modelFile();
  if (file.exists && file.size > 0) return file;

  const dir = modelDir();
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });

  // gh-proxy 是国内可访问的 GitHub/HF 镜像；桌面端同款策略
  const proxyUrl = `https://gh-proxy.com/${WHISPER_MODEL.url}`;
  const task = File.createDownloadTask(proxyUrl, file, {
    onProgress: ({ bytesWritten, totalBytes }) => {
      if (onProgress && totalBytes > 0) {
        onProgress({
          percent: Math.min(100, Math.round((bytesWritten / totalBytes) * 100)),
          bytesWritten,
          totalBytes,
        });
      }
    },
  });

  const downloaded = await task.downloadAsync();
  if (!downloaded || !downloaded.exists || downloaded.size <= 0) {
    throw new Error('模型下载失败：文件为空');
  }
  return downloaded;
}