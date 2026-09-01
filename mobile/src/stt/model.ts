import { Directory, File, Paths } from 'expo-file-system';

/**
 * whisper.cpp 多语言模型（支持中文），q5_1 量化：体积/质量折中。
 * small 比 base 识别率高一大截（中文场景尤其明显），代价是体积 56.9MB → 190MB。
 */
export const WHISPER_MODEL = {
  /** 模型文件名，与 HF 仓库一致 */
  name: 'ggml-small-q5_1.bin',
  /** 原始 HF 直链 */
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin',
  /** 体积约 190MB */
  sizeBytes: 190 * 1024 * 1024,
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

const HF_PREFIX = 'https://huggingface.co/';
const HF_MIRROR_PREFIX = 'https://hf-mirror.com/';

function downloadCandidates(): string[] {
  const hfPath = WHISPER_MODEL.url.slice(HF_PREFIX.length);
  return [
    `https://gh-proxy.com/${WHISPER_MODEL.url}`,
    `${HF_MIRROR_PREFIX}${hfPath}`,
    WHISPER_MODEL.url,
  ];
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function downloadOnce(
  url: string,
  target: File,
  onProgress?: (progress: ModelProgress) => void,
): Promise<File> {
  const task = File.createDownloadTask(url, target, {
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
    throw new Error('文件为空');
  }
  return downloaded;
}

/**
 * 确保模型可用：已缓存则直接返回，否则按 gh-proxy → hf-mirror → HF 直链依次尝试。
 * 带进度回调（百分比）。
 */
export async function ensureModel(
  onProgress?: (progress: ModelProgress) => void,
): Promise<File> {
  const file = modelFile();
  if (file.exists && file.size > 0) return file;

  const dir = modelDir();
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });

  const failures: string[] = [];
  for (const url of downloadCandidates()) {
    try {
      if (file.exists) file.delete();
      return await downloadOnce(url, file, onProgress);
    } catch (err) {
      failures.push(`${url}: ${errorMessage(err)}`);
      if (file.exists) file.delete();
    }
  }

  throw new Error(`下载语音模型失败，请检查网络或代理。${failures.join('；')}`);
}
