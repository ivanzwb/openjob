import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app, nativeImage, type NativeImage } from 'electron';

/** Windows 任务栏/标题栏需要 .ico；打包时 electron-builder 读取 build/ 目录 */
export function resolveAppIcon(): NativeImage | undefined {
  const roots = [process.cwd(), app.getAppPath()];
  const names =
    process.platform === 'win32'
      ? ['build/icon.ico', 'build/icon.png', 'resources/logo.png']
      : ['build/icon.png', 'resources/logo.png'];

  const relFromMain = [
    '../../build/icon.ico',
    '../../build/icon.png',
    '../../resources/logo.png',
  ];

  const candidates = [
    ...roots.flatMap((root) => names.map((n) => join(root, n))),
    ...relFromMain.map((rel) => join(import.meta.dirname, rel)),
  ];

  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const image = nativeImage.createFromPath(p);
    if (!image.isEmpty()) return image;
  }
  return undefined;
}

export function applyAppIcon(): NativeImage | undefined {
  const icon = resolveAppIcon();
  if (!icon) return undefined;

  if (process.platform === 'win32') {
    app.setAppUserModelId('com.openjob.app');
  }
  return icon;
}
