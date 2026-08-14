import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * 寸照上传。
 *
 * 照片存成 data URL，跟着简历行走同步与导出；原图一律先缩到证件照尺寸再转 JPEG，
 * 否则手机拍的几 MB 原图会整份塞进数据库，同步和 PDF 都会被拖慢。
 */

/** 35×49mm 证件照在 300dpi 下约 413×579，取整到这个上限足够印刷清晰 */
const MAX_WIDTH = 420;
const MAX_HEIGHT = 580;
const JPEG_QUALITY = 0.86;
/** 选进来的原图上限，再大基本是没压过的相机原图 */
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

async function decode(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch {
    // iPhone 直接导出的 HEIC 走到这里，说清楚要转格式，别只报一句失败
    throw new Error('这张图解不开，请换 JPG 或 PNG（iPhone 的 HEIC 需先转换）');
  }
}

async function toPhotoDataUrl(file: File): Promise<string> {
  if (file.size > MAX_SOURCE_BYTES) throw new Error('图片太大，请选 20MB 以内的照片');
  const bitmap = await decode(file);
  try {
    const scale = Math.min(1, MAX_WIDTH / bitmap.width, MAX_HEIGHT / bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('浏览器不支持处理图片');
    // 透明底的 PNG 转 JPEG 会变黑，先铺白
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  } finally {
    bitmap.close();
  }
}

function PhotoZoom({ photo, onClose }: { photo: string; onClose: () => void }): React.JSX.Element {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/70 p-8"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex flex-col items-center gap-3">
        <img
          src={photo}
          alt="寸照"
          className="max-h-[70vh] rounded-lg bg-white shadow-2xl"
        />
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-white/30 px-3 py-1 text-xs text-white/80 hover:text-white"
        >
          关闭
        </button>
      </div>
    </div>,
    document.body,
  );
}

const GHOST_BTN =
  'whitespace-nowrap rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] disabled:opacity-40';

export function ResumePhotoField({
  photo,
  onChange,
}: {
  photo: string | null;
  onChange: (photo: string | null) => void;
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);

  const accept = (file: File | undefined): void => {
    if (!file) return;
    setError(null);
    setBusy(true);
    void toPhotoDataUrl(file)
      .then(onChange)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '图片读取失败'))
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex items-start gap-3">
      <div className="w-[84px] shrink-0">
        {photo ? (
          <button
            type="button"
            onClick={() => setZoomOpen(true)}
            title="点击放大查看"
            className="block h-[112px] w-full overflow-hidden rounded border border-[var(--color-border)] bg-white"
          >
            <img src={photo} alt="寸照" className="size-full object-cover" />
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            className="flex h-[112px] w-full flex-col items-center justify-center gap-1 rounded border border-dashed border-[var(--color-border)] text-xs text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-fg)] disabled:opacity-40"
          >
            <span className="text-base leading-none">+</span>
            <span>寸照</span>
          </button>
        )}
      </div>

      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={GHOST_BTN}
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? '处理中…' : photo ? '更换' : '上传'}
          </button>
          {photo && (
            <>
              <button type="button" className={GHOST_BTN} onClick={() => setZoomOpen(true)}>
                预览
              </button>
              <button
                type="button"
                className={`${GHOST_BTN} text-red-400`}
                disabled={busy}
                onClick={() => {
                  setError(null);
                  onChange(null);
                }}
              >
                移除
              </button>
            </>
          )}
        </div>
        <p className="text-xs leading-relaxed text-[var(--color-muted)]">
          照片会排在简历抬头右侧，跟着模板一起进预览与导出的 PDF；建议用 3:4 的证件照，过大的图会自动压缩。
        </p>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          accept(e.target.files?.[0]);
          // 同一个文件再选一次也要能触发 change
          e.target.value = '';
        }}
      />

      {zoomOpen && photo && <PhotoZoom photo={photo} onClose={() => setZoomOpen(false)} />}
    </div>
  );
}
