/**
 * 把默认插件（软件工程岗位包）放进 `resources/default-plugins/`，随安装包一起分发。
 *
 * 默认的岗位包在启动时由 `src/main/plugins/defaultPlugin.ts` 从那里装进 `pluginsDir`——
 * 升级上来的老战役因此开箱就有运行配置，不必先去设置页装包。
 *
 * 来源是 `dist-plugins/`（`scripts/pack-plugins.mjs` 的产物）。没有就先打包：本地出包时
 * 没人会记得先跑一次 `pnpm pack:plugins`，缺了它安装包里就没有默认岗位包，而这件事不会
 * 报错、只会「装完发现岗位列表是空的」。
 *
 * 打包用的私钥从 `OPENJOB_PLUGIN_PRIVATE_KEY` 读（见 pack-plugins.mjs）：没配时会用临时
 * 密钥，产出的包不是第一方签名，启动时的自动安装会拒收——此处照实提示，不静默放过。
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PLUGIN_ID = 'software-engineering';
const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = resolve(HERE, '..');
const REPO_ROOT = resolve(DESKTOP_DIR, '..');
const BUNDLES_DIR = join(REPO_ROOT, 'dist-plugins');
const TARGET_DIR = join(DESKTOP_DIR, 'resources', 'default-plugins');

function bundlesFor(id) {
  if (!existsSync(BUNDLES_DIR)) return [];
  return readdirSync(BUNDLES_DIR)
    .filter((name) => name.startsWith(`${id}@`) && name.endsWith('.ojb'))
    .sort();
}

function packBundles() {
  console.log('dist-plugins/ 里没有默认岗位包，先跑一次 scripts/pack-plugins.mjs');
  execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', 'pack-plugins.mjs')], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
}

const bundles = bundlesFor(DEFAULT_PLUGIN_ID);
const packedHere = bundles.length === 0;
if (packedHere) packBundles();
const found = bundlesFor(DEFAULT_PLUGIN_ID);
if (found.length === 0) {
  console.error(`没有产出 ${DEFAULT_PLUGIN_ID} 的包，安装包里将不带默认岗位包`);
  process.exit(1);
}

// 每次重铺：上一次的旧版本留着会在启动时被当作「本机已装」，新版本反而进不去
rmSync(TARGET_DIR, { recursive: true, force: true });
mkdirSync(TARGET_DIR, { recursive: true });

for (const name of found) {
  copyFileSync(join(BUNDLES_DIR, name), join(TARGET_DIR, name));
  const { size } = statSync(join(TARGET_DIR, name));
  console.log(`默认插件 → resources/default-plugins/${name}（${size} 字节）`);
}

// 只在「这里刚打的包」上提醒签名来源：CI 里用的是 package-plugins 打好的第一方产物，
// 那条路径与私钥无关，无差别地警告只会让日志说谎
if (packedHere && !process.env.OPENJOB_PLUGIN_PRIVATE_KEY) {
  console.warn(
    '未设置 OPENJOB_PLUGIN_PRIVATE_KEY：上面的包不是第一方签名，启动时的自动安装会拒收它。',
  );
}
