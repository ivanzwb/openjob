/**
 * 把插件打成可单独分发的签名包，外加一份浏览用的 index.json。
 *
 * 用 vite 的 ssrLoadModule 加载 TS，而不是在这里重写一遍格式与签名逻辑：脚本里另写一份
 * 摘要或签名，产出的包应用会直接拒收，而报错会指向「内容与签名不符」——一条完全指错方向
 * 的线索。打包与校验必须共用同一段代码。
 *
 * 用法：
 *   node scripts/pack-plugins.mjs [--out dist-plugins] [--only <pluginId>]
 *
 * --only 只打指定插件（id 见各插件 manifest / dist-plugins/index.json），用于单插件独立发版；
 * 缺省打全部。index.json 始终只登记本次实际产出的包。
 *
 * 签名私钥从 OPENJOB_PLUGIN_PRIVATE_KEY 读（PEM，CI 里放 secret）。没配就临时生成一把并
 * 大声警告：产出的包能装，但不是第一方签名，用户装的时候要手动确认来源。
 */
import { Buffer } from 'node:buffer';
import { generateKeyPairSync, createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const OUT_DIR = resolve(outIndex === -1 ? 'dist-plugins' : args[outIndex + 1]);
const onlyIndex = args.indexOf('--only');
const ONLY = onlyIndex === -1 ? undefined : args[onlyIndex + 1];
const ROOT = process.cwd();

async function loadModules() {
  const server = await createServer({
    configFile: false,
    root: ROOT,
    logLevel: 'warn',
    // 只需要 @core / @plugins 这两条别名；不复用 desktop/electron.vite.config.ts 是
    // 因为它是多目标配置，在这里加载会把 main/renderer 的插件链一起拖进来。
    // 数组形式的理由见 core/vitest.config.ts：`@plugins` 要精确匹配。
    resolve: {
      alias: [
        { find: '@core', replacement: resolve(ROOT, 'core/src') },
        { find: /^@plugins$/, replacement: resolve(ROOT, 'scripts/distributed-role-packs.ts') },
        { find: /^@plugins\//, replacement: `${resolve(ROOT, 'plugins')}/` },
      ],
    },
    server: { middlewareMode: true },
    // 没有这两项，vite 会去扫 desktop 的渲染进程入口并对整个前端做依赖预构建，
    // 只为读几个纯数据模块
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const suite = await server.ssrLoadModule('core/src/plugins/capabilitySuite.ts');
    const rolePacks = await server.ssrLoadModule('scripts/distributed-role-packs.ts');
    const transfer = await server.ssrLoadModule('core/src/plugins/package/rolePackTransfer.ts');
    const capabilityTransfer = await server.ssrLoadModule(
      'core/src/plugins/package/capabilityTransfer.ts',
    );
    const contract = await server.ssrLoadModule('core/src/plugins/package/contract.ts');
    const bundle = await server.ssrLoadModule('desktop/src/main/plugins/bundle.ts');
    return { suite, rolePacks, transfer, capabilityTransfer, contract, bundle };
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
  const { suite, rolePacks, transfer, capabilityTransfer, contract, bundle } = await loadModules();
  const key = resolveSigningKey();

  /**
   * 基础包不再内置任何插件，这里产出全部随 release 分发的包：
   *
   * - 三个岗位包：一个岗位一个包，用户按自己的岗位装一个；
   * - 一个能力合编包（源码仓库 + 角色扮演 + 案例拆解）：需要的用户装它一个。
   *
   * 能力包能装上了：三个旧 id@1.0.0 已从内置清单退役（只留在 reserved 名册里防抢注），
   * 合编包用新 id 走与岗位包完全相同的安装链路。
   */
  // 拆分走各 transfer：手机端收岗位包、安装端解析都复用同一份定义
  // 代码插件（v3）：examples/ 下的纯文本资产直接读入，无需 ssrLoadModule
  const CODE_PLUGIN_DIR = join(ROOT, 'examples', 'portfolio-board');
  const codeFiles = {};
  for (const name of ['manifest.json', 'main.js', 'ui/index.html']) {
    codeFiles[name] = readFileSync(join(CODE_PLUGIN_DIR, name), 'utf8');
  }
  const codeIssues = contract.validatePluginPackage(codeFiles);
  if (codeIssues.length > 0) {
    const detail = codeIssues.map((issue) => `  ${issue.path}: ${issue.message}`).join('\n');
    throw new Error(`代码插件 ${CODE_PLUGIN_DIR} 校验失败：\n${detail}`);
  }

  const allPackages = [
    ...rolePacks.DISTRIBUTED_ROLE_PACKS.map((pack) => ({
      manifest: pack.manifest,
      files: transfer.rolePackToPackageFiles(pack),
    })),
    {
      manifest: suite.coreCapabilitiesSuite.manifest,
      files: capabilityTransfer.capabilityPluginToPackageFiles(suite.coreCapabilitiesSuite),
    },
    {
      manifest: JSON.parse(codeFiles['manifest.json']),
      files: codeFiles,
    },
  ];

  const packages = ONLY
    ? allPackages.filter(({ manifest }) => manifest.id === ONLY)
    : allPackages;
  if (ONLY && packages.length === 0) {
    throw new Error(
      `没有 id 为 ${ONLY} 的插件。可选：${allPackages.map((p) => p.manifest.id).join('、')}`,
    );
  }
  if (ONLY) console.log(`只打 ${ONLY}@${packages[0].manifest.version}`);

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
