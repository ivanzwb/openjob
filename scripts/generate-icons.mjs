import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const { default: pngToIco } = await import('png-to-ico');
const buf = await pngToIco(existsSync(winSrc) ? winSrc : src);
const fs = await import('node:fs/promises');
await fs.writeFile(join(buildDir, 'icon.ico'), buf);

const rendererPublic = join(root, 'src', 'renderer', 'public');
mkdirSync(rendererPublic, { recursive: true });
copyFileSync(src, join(rendererPublic, 'logo.png'));
await fs.writeFile(join(rendererPublic, 'favicon.ico'), buf);
copyFileSync(src, join(rendererPublic, 'favicon.png'));

console.log('Generated build/icon.png and build/icon.ico');
