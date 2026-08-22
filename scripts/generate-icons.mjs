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

/**
 * Windows 会按当前 DPI 挑最接近的档位，挑不到就拿更小的那档撑进框里显示——
 * 任务栏 100% 缩放要的是 24x24，而 png-to-ico 只固定生成 16/32/48/256，
 * 结果是 16 的图标摆在 24 的格子里，看着比别的应用小一圈。
 * 这里用它内部的 resize/imagesToIco 自己铺满常用档位。
 */
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

async function buildIco(file) {
  const { imagesToIco } = await import('png-to-ico');
  const { readPNG, resize } = await import('png-to-ico/lib/png.js');

  const source = await readPNG(file);
  // 先降到 256 再逐档缩放，与 png-to-ico 自身的两步做法一致，小尺寸更干净
  const base = source.width === 256 ? source : resize(source, 256, 256);
  const images = ICO_SIZES.map((size) => (size === 256 ? base : resize(base, size, size)));
  return imagesToIco(images);
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
const buf = await buildIco(icoSrc);
const fs = await import('node:fs/promises');
await fs.writeFile(join(buildDir, 'icon.ico'), buf);

const rendererPublic = join(root, 'src', 'renderer', 'public');
mkdirSync(rendererPublic, { recursive: true });
copyFileSync(src, join(rendererPublic, 'logo.png'));
await fs.writeFile(join(rendererPublic, 'favicon.ico'), buf);
copyFileSync(src, join(rendererPublic, 'favicon.png'));

console.log('Generated build/icon.png and build/icon.ico');
