import { mkdirSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** PNG 首块必须是 IHDR，宽高在固定偏移上，不必为一次尺寸校验引入图片库 */
function readPngSize(file) {
  const buf = readFileSync(file);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * png-to-ico 只接受正方形输入，报错信息里不带文件名。
 * 之前 logo-win.png 被导出成 1024x1025，图标生成就一直失败、
 * build/icon.ico 停留在旧版本，任务栏图标比设计稿小了一圈也没人发现。
 */
function assertSquare(file) {
  const { width, height } = readPngSize(file);
  if (width === height) return;
  console.error(
    `${file} 是 ${width}x${height}，不是正方形；png-to-ico 会拒绝，图标无法生成。` +
      '请把源图导出成正方形（多余的透明边裁掉）后重试。',
  );
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'resources', 'logo.png');
const winSrc = join(root, 'resources', 'logo-win.png');
const buildDir = join(root, 'build');

if (!existsSync(src)) {
  console.error('Missing resources/logo.png');
  process.exit(1);
}

mkdirSync(buildDir, { recursive: true });
copyFileSync(src, join(buildDir, 'icon.png'));
const icoSrc = existsSync(winSrc) ? winSrc : src;
assertSquare(icoSrc);
const { default: pngToIco } = await import('png-to-ico');
const buf = await pngToIco(icoSrc);
const fs = await import('node:fs/promises');
await fs.writeFile(join(buildDir, 'icon.ico'), buf);

const rendererPublic = join(root, 'src', 'renderer', 'public');
mkdirSync(rendererPublic, { recursive: true });
copyFileSync(src, join(rendererPublic, 'logo.png'));
await fs.writeFile(join(rendererPublic, 'favicon.ico'), buf);
copyFileSync(src, join(rendererPublic, 'favicon.png'));

console.log('Generated build/icon.png and build/icon.ico');
