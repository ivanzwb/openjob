/**
 * 把插件打成可单独分发的签名包，外加一份浏览用的 index.json。
 *
 * 用 vite 的 ssrLoadModule 加载 TS，而不是在这里重写一遍格式与签名逻辑：脚本里另写一份
 * 摘要或签名，产出的包应用会直接拒收，而报错会指向「内容与签名不符」——一条完全指错方向
 * 的线索。打包与校验必须共用同一段代码。
 *
 * 用法：
 *   node scripts/pack-plugins.mjs [--out dist-plugins]
 *
 * 签名私钥从 OPENJOB_PLUGIN_PRIVATE_KEY 读（PEM，CI 里放 secret）。没配就临时生成一把并
 * 大声警告：产出的包能装，但不是第一方签名，用户装的时候要手动确认来源。
 */
import { Buffer } from 'node:buffer';
import { generateKeyPairSync, createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const OUT_DIR = resolve(outIndex === -1 ? 'dist-plugins' : args[outIndex + 1]);
const ROOT = process.cwd();

async function loadModules() {
  const server = await createServer({
    configFile: false,
    root: ROOT,
    logLevel: 'warn',
    // 只需要 @shared 这一条别名；不复用 electron.vite.config.ts 是因为它是多目标配置，
    // 在这里加载会把 main/renderer 的插件链一起拖进来
    resolve: { alias: { '@shared': resolve(ROOT, 'src/shared') } },
    server: { middlewareMode: true },
    // 没有这两项，vite 会去扫根目录的 src/renderer/index.html 并对整个前端做依赖预构建，
    // 只为读几个纯数据模块
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const builtin = await server.ssrLoadModule('src/shared/plugins/builtin/index.ts');
    const rolePacks = await server.ssrLoadModule('src/shared/plugins/rolePacks/index.ts');
    const replay = await server.ssrLoadModule('src/shared/plugins/package/replay.ts');
    const transfer = await server.ssrLoadModule('src/shared/plugins/package/rolePackTransfer.ts');
    const bundle = await server.ssrLoadModule('src/main/plugins/bundle.ts');
    return { builtin, rolePacks, replay, transfer, bundle };
  } finally {
    await server.close();
  }
}

/**
 * 私钥可以是 PEM、把换行写成 \n 的 PEM，或者 PEM 的 base64。
 *
 * 多行 secret 经过 CI 与 shell 常被改形（换行被吞是最常见的一种），只认一种写法会让发布
 * 在「密钥明明配了」的情况下失败。
 */
function normalizePem(raw) {
  const value = raw.trim();
  if (value.includes('-----BEGIN')) return value.replace(/\\n/g, '\n');
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    if (decoded.includes('-----BEGIN')) return decoded;
  } catch {
    // 落到下面统一报错
  }
  throw new Error('OPENJOB_PLUGIN_PRIVATE_KEY 既不是 PEM 也不是 PEM 的 base64');
}

function resolveSigningKey() {
  const raw = process.env['OPENJOB_PLUGIN_PRIVATE_KEY'];
  if (raw) {
    const privateKey = createPrivateKey(normalizePem(raw));
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('OPENJOB_PLUGIN_PRIVATE_KEY 必须是 Ed25519 私钥');
    }
    return {
      privateKey,
      publicKeyPem: createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString(),
      firstParty: true,
    };
  }

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  console.warn(
    '\n⚠ 未配置 OPENJOB_PLUGIN_PRIVATE_KEY，本次用临时密钥签名。\n' +
      '  产出的包能装，但不是第一方签名，用户安装时需要手动确认来源。\n',
  );
  return {
    privateKey,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    firstParty: false,
  };
}

async function main() {
  const { rolePacks, transfer, bundle } = await loadModules();
  const key = resolveSigningKey();

  /**
   * 只打岗位包。
   *
   * 能力插件不单独分发：它们声明的工具、解析器与交互类型的实现都在宿主里
   * （`src/main/repo/tools.ts` 等），声明与实现必须同一版本发布。真打出来也装不上——
   * `builtInPluginKeys()` 把内置的 id@version 占住了，安装会以 reserved-id 被拒。
   */
  // 拆分走 rolePackTransfer：手机端收包也用这一处，「岗位包怎么变成包内文件」只有一份定义
  const packages = rolePacks.DISTRIBUTED_ROLE_PACKS.map((pack) => ({
    manifest: pack.manifest,
    files: transfer.rolePackToPackageFiles(pack),
  }));

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const entries = [];
  for (const { manifest, files } of packages) {
    const signed = bundle.signPackageFiles(files, key.privateKey, key.publicKeyPem);
    const json = bundle.toBundleJson(signed);
    const file = `${manifest.id}@${manifest.version}.openjob.json`;
    writeFileSync(join(OUT_DIR, file), json, 'utf8');

    entries.push({
      id: manifest.id,
      version: manifest.version,
      type: manifest.type,
      displayName: manifest.displayName,
      description: manifest.description,
      // 权限进 index：用户在装之前就该看到这个包要申请什么，而不是装完才知道
      permissions: manifest.permissions,
      file,
      bytes: Buffer.byteLength(json, 'utf8'),
      sha256: createHash('sha256').update(json, 'utf8').digest('hex'),
    });
    console.log(`  ${file}  ${entries.at(-1).bytes} bytes`);
  }

  entries.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  writeFileSync(
    join(OUT_DIR, 'index.json'),
    `${JSON.stringify(
      {
        formatVersion: 1,
        // 签名公钥随清单发布，方便自建分发的人核对；信任与否仍由基础包内置的密钥决定
        publicKey: key.publicKeyPem,
        firstParty: key.firstParty,
        plugins: entries,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  console.log(`\n共 ${entries.length} 个包 → ${OUT_DIR}`);
  if (!key.firstParty) console.log('公钥：\n' + key.publicKeyPem);
}

await main();
