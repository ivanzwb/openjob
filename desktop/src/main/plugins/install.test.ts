/**
 * 安装与卸载。
 *
 * 用真实临时 userData：这一层的价值是「盘上最终留下了什么」，mock 掉文件系统就没了。
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const paths = { userData: '', pluginsDir: '' };

vi.mock('../paths', () => ({
  getAppPaths: () => paths,
}));

// 装默认岗位包（software-engineering）后 bootstrap 会立即重跑旧战役回填，回填入口要碰
// 真实库——单测环境没有库。这个测试文件验证的是 install.ts 的把关与落盘，不是回填逻辑，
// 因此置顶 mock 让 getRawDb 直接抛错（bootstrap 对回填失败只记 warn，不中断安装）。
vi.mock('../db', () => ({
  getRawDb: () => {
    throw new Error('install.test must not touch the real DB');
  },
}));

// bootstrap 在扫描/安装/卸载后广播 plugin:inventory-changed；bridge 会拉起 electron，
// 测试环境没有 electron 运行时，这里把它换成一个可断言的桩。
vi.mock('../ipc/bridge', () => ({ emit: vi.fn() }));

import { DISTRIBUTED_ROLE_PACKS } from '@plugins';
import {
  PACKAGE_MANIFEST_FILE,
  PACKAGE_PACK_FILE,
  type PluginPackageFiles,
} from '@core/plugins/package/contract';
import type { RolePack } from '@core/plugins/types';
import { emit } from '../ipc/bridge';
import { signPackageFiles, encodeBundle } from './bundle';
import { loadExternalPlugins } from './bootstrap';
import { ensureBundledDefaultPlugin } from './defaultPlugin';
import { installPluginBundle, parseBundle, removeRejectedPluginDir, uninstallPlugin } from './install';
import { setExternalPlugins } from './runtime';

const publisher = generateKeyPairSync('ed25519');
const PUBLISHER_PEM = publisher.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const stranger = generateKeyPairSync('ed25519');
const STRANGER_PEM = stranger.publicKey.export({ type: 'spki', format: 'pem' }).toString();

/**
 * 装成第一方发布密钥。
 *
 * 位置必须跟着 trustedKeys 的解析口径走：它按 `process.cwd()/resources` 回落（开发期），
 * install.ts 里又是无参调用，没法注入目录，所以这里只能照同一条路径铺。
 * 目录按需创建——cwd 取决于在哪儿起的 vitest，工作区根下并没有 resources/。
 */
const RESOURCES_DIR = join(process.cwd(), 'resources');
const KEY_FILE = join(RESOURCES_DIR, 'plugin-keys.json');

function writeTrustedKey(): void {
  mkdirSync(RESOURCES_DIR, { recursive: true });
  writeFileSync(KEY_FILE, JSON.stringify({ keys: [PUBLISHER_PEM] }));
}

let keyFileExisted = false;
let keyFileBackup: string | null = null;
let resourcesDirExisted = false;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'openjob-install-'));
  paths.userData = root;
  paths.pluginsDir = join(root, 'plugins');
  resourcesDirExisted = existsSync(RESOURCES_DIR);
  keyFileExisted = existsSync(KEY_FILE);
  // 仓库里那份是随包分发的第一方公钥：从 desktop/ 起 vitest 时它就在这条路径上，
  // 覆盖后就等于把真公钥换成测试密钥，跑完必须原样还回去
  keyFileBackup = keyFileExisted ? readFileSync(KEY_FILE, 'utf8') : null;
  writeTrustedKey();
});

afterEach(() => {
  rmSync(paths.userData, { recursive: true, force: true });
  if (keyFileBackup !== null) writeFileSync(KEY_FILE, keyFileBackup);
  else if (!keyFileExisted) rmSync(KEY_FILE, { force: true });
  keyFileBackup = null;
  // 自己建的目录自己收拾，别在仓库里留个空 resources/
  if (!resourcesDirExisted) rmSync(RESOURCES_DIR, { recursive: true, force: true });
  setExternalPlugins([]);
});

/** 包声明的形状决定它能不能让旧战役恢复原功能：带材料（materialKind）的任务模板才是。 */
function declaresMaterialTask(pack: RolePack): boolean {
  return pack.taskTemplates.some((template) => template.materialKind !== undefined);
}

/**
 * 恢复型岗位包：声明了带材料任务模板，装上即让旧战役恢复原功能（软件工程包就是这个形状，
 * `se.read-code` 挂一份代码材料）。基础包不再点名它，判据是包声明的形状。
 */
const RESTORING_ROLE_PACK = DISTRIBUTED_ROLE_PACKS.find((pack) => declaresMaterialTask(pack))!;

/**
 * 「别的角色包」的形状：不声明带材料任务模板，装上不会恢复旧战役（产品 / 销售包就是这样，
 * 任务页由包自己渲染，不带材料任务）。
 */
const OTHER_ROLE_PACK = DISTRIBUTED_ROLE_PACKS.find((pack) => !declaresMaterialTask(pack))!;

function rolePackFiles(
  id = 'demo.role',
  version = '2.0.0',
  source: RolePack = OTHER_ROLE_PACK,
): PluginPackageFiles {
  const { manifest, ...rest } = structuredClone(source);
  return {
    [PACKAGE_MANIFEST_FILE]: JSON.stringify({ ...manifest, id, version, dependencies: [] }),
    [PACKAGE_PACK_FILE]: JSON.stringify(rest),
  };
}

function bundle(
  files: PluginPackageFiles = rolePackFiles(),
  signer = publisher,
  signerPem = PUBLISHER_PEM,
): Buffer {
  return encodeBundle(signPackageFiles(files, signer.privateKey, signerPem));
}

function installedDirs(): string[] {
  return existsSync(paths.pluginsDir) ? readdirSync(paths.pluginsDir).sort() : [];
}

describe('parseBundle', () => {
  it('只接受 .ojb 压缩容器，裸 JSON 一律拒', () => {
    const raw = bundle();
    expect(parseBundle(raw).ok).toBe(true);

    const plain = parseBundle(gunzipSync(raw));
    expect(plain.ok).toBe(false);
    if (!plain.ok) expect(plain.detail).toContain('.ojb');
  });

  it('信封里出现白名单外的文件名就拒，路径穿越无从谈起', () => {
    // 不引 zip 解析器的理由就在这：条目名在这一步被限死成四个常量之一
    for (const name of ['../../evil.json', 'plugin.mjs', 'nested/manifest.json']) {
      const parsed = parseBundle(encodeBundle({ [name]: '{}' }));

      expect(parsed.ok, name).toBe(false);
      if (!parsed.ok) expect(parsed.detail).toContain(name);
    }
  });

  it('缺 files、不是 JSON、内容不是字符串都拒', () => {
    for (const raw of ['{}', 'not json', '{"files":[]}', '{"files":{"manifest.json":123}}']) {
      expect(parseBundle(gzipSync(Buffer.from(raw, 'utf8'))).ok, raw).toBe(false);
    }
  });

  it('gzip 炸弹被解压上限挡住，而不是吃光内存', () => {
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024, 0x20));

    const parsed = parseBundle(bomb);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.detail).toContain('解压失败');
  });
});

describe('installPluginBundle', () => {
  it('第一方签名的包装到 <id>@<version> 目录，并立即可用', () => {
    const result = installPluginBundle(bundle());

    expect(result).toMatchObject({ ok: true, id: 'demo.role', version: '2.0.0', trust: 'first-party' });
    expect(installedDirs()).toEqual(['demo.role@2.0.0']);
  });

  it('装完之后暂存目录不留在 plugins/ 下', () => {
    installPluginBundle(bundle());

    // 暂存目录若留在 plugins/ 里，下次扫描会把它自己报成一个坏包
    expect(installedDirs()).toEqual(['demo.role@2.0.0']);
  });

  it('陌生签名者默认拒装，显式确认后放行', () => {
    const raw = bundle(rolePackFiles(), stranger, STRANGER_PEM);

    expect(installPluginBundle(raw)).toMatchObject({ code: 'untrusted-signer' });
    expect(installedDirs()).toEqual([]);

    expect(installPluginBundle(raw, { trustUnknownSigner: true })).toMatchObject({
      ok: true,
      trust: 'unknown-signer',
    });
  });

  it('签完再改内容一律拒装，确认信任也不放行', () => {
    const signed = signPackageFiles(rolePackFiles(), publisher.privateKey, PUBLISHER_PEM);
    const tampered = encodeBundle({ ...signed, [PACKAGE_PACK_FILE]: '{"competencyTemplates":[]}' });

    for (const options of [{}, { trustUnknownSigner: true }]) {
      expect(installPluginBundle(tampered, options)).toMatchObject({ code: 'tampered' });
    }
    expect(installedDirs()).toEqual([]);
  });

  it('没签名的包拒装', () => {
    const raw = encodeBundle(rolePackFiles());

    expect(installPluginBundle(raw)).toMatchObject({ code: 'unsigned' });
  });

  it('格式不合法的包拒装，且不在盘上留痕', () => {
    const files = rolePackFiles();
    const broken = { ...files, [PACKAGE_PACK_FILE]: '{"competencyTemplates":[]}' };

    expect(installPluginBundle(bundle(broken))).toMatchObject({ code: 'invalid-package' });
    expect(installedDirs()).toEqual([]);
  });

  it('官方岗位包的 id@version 不被任何名册占用', () => {
    // 基础包里没有任何插件，也没有保留名册：官方包的 id@version 必须装得进来
    const pack = DISTRIBUTED_ROLE_PACKS[0]!.manifest;
    const files = rolePackFiles(pack.id, pack.version);

    expect(installPluginBundle(bundle(files))).toMatchObject({ ok: true });
  });

  it('重复安装默认拒绝，overwrite 才覆盖', () => {
    installPluginBundle(bundle());

    expect(installPluginBundle(bundle())).toMatchObject({ code: 'already-installed' });
    expect(installPluginBundle(bundle(), { overwrite: true })).toMatchObject({ ok: true });
    expect(installedDirs()).toEqual(['demo.role@2.0.0']);
  });

  it('同 id 的不同版本可以并存', () => {
    installPluginBundle(bundle(rolePackFiles('demo.role', '2.0.0')));
    installPluginBundle(bundle(rolePackFiles('demo.role', '2.1.0')));

    expect(installedDirs()).toEqual(['demo.role@2.0.0', 'demo.role@2.1.0']);
  });

  it('默认岗位包之外的角色包：库里有未映射旧战役时先要用户确认', () => {
    const raw = bundle();

    expect(
      installPluginBundle(raw, { countPendingPrePluginCampaigns: () => 2 }),
    ).toMatchObject({ code: 'confirm-data-loss' });
    expect(installedDirs()).toEqual([]);

    expect(
      installPluginBundle(raw, {
        countPendingPrePluginCampaigns: () => 2,
        confirmDataLoss: true,
      }),
    ).toMatchObject({ ok: true, id: 'demo.role' });
  });

  it('没有待映射旧战役时，非默认岗位包照常安装', () => {
    expect(
      installPluginBundle(bundle(), { countPendingPrePluginCampaigns: () => 0 }),
    ).toMatchObject({ ok: true });
  });

  it('默认岗位包（软件工程）装上即恢复原功能，不触发数据丢失把关', () => {
    const files = rolePackFiles('software-engineering', '2.0.0', RESTORING_ROLE_PACK);

    expect(
      installPluginBundle(bundle(files), { countPendingPrePluginCampaigns: () => 2 }),
    ).toMatchObject({ ok: true, id: 'software-engineering' });
  });
});

describe('一个设备只装一个插件', () => {
  it('已经装了别的插件就拒装，并说清该先卸载谁', () => {
    installPluginBundle(bundle(rolePackFiles('demo.role', '2.0.0')));

    const result = installPluginBundle(bundle(rolePackFiles('demo.other', '1.0.0')));

    expect(result).toMatchObject({ code: 'one-plugin-limit' });
    if (!result.ok) expect(result.detail).toContain('demo.role@2.0.0');
    expect(installedDirs()).toEqual(['demo.role@2.0.0']);
  });

  it('卸载之后才装得上另一个', () => {
    installPluginBundle(bundle(rolePackFiles('demo.role', '2.0.0')));
    uninstallPlugin('demo.role', '2.0.0');

    expect(installPluginBundle(bundle(rolePackFiles('demo.other', '1.0.0')))).toMatchObject({
      ok: true,
      id: 'demo.other',
    });
    expect(installedDirs()).toEqual(['demo.other@1.0.0']);
  });

  it('同一个 id 的其它版本不受限制：那是升级或回退', () => {
    // 旧版本留着，pin 在旧版本上的战役才跑得动。删掉旧版本等于顺手把那些战役变成只读
    installPluginBundle(bundle(rolePackFiles('demo.role', '2.0.0')));

    expect(installPluginBundle(bundle(rolePackFiles('demo.role', '2.1.0')))).toMatchObject({
      ok: true,
    });
    expect(installedDirs()).toEqual(['demo.role@2.0.0', 'demo.role@2.1.0']);
  });

  it('坏包先按坏包报，而不是先让人去卸载', () => {
    // 顺序反过来的话，用户卸完已装的插件才发现包本身也是坏的
    installPluginBundle(bundle(rolePackFiles('demo.role', '2.0.0')));
    const tampered = signPackageFiles(rolePackFiles('demo.other'), publisher.privateKey, PUBLISHER_PEM);

    expect(
      installPluginBundle(
        encodeBundle({ ...tampered, [PACKAGE_PACK_FILE]: '{"competencyTemplates":[]}' }),
      ),
    ).toMatchObject({ code: 'tampered' });
  });

  it('挡住装不进去这件事优先于数据丢失确认：两道都拦时先说要卸载', () => {
    installPluginBundle(bundle(rolePackFiles('demo.role', '2.0.0')));

    expect(
      installPluginBundle(bundle(rolePackFiles('demo.other', '1.0.0')), {
        countPendingPrePluginCampaigns: () => 2,
      }),
    ).toMatchObject({ code: 'one-plugin-limit' });
  });
});

describe('uninstallPlugin', () => {
  it('删掉目录并报告删过', () => {
    installPluginBundle(bundle());

    expect(uninstallPlugin('demo.role', '2.0.0')).toEqual({ removed: true });
    expect(installedDirs()).toEqual([]);
  });

  it('没装过也算成功，调用方不必先查', () => {
    expect(uninstallPlugin('never.installed', '1.0.0')).toEqual({ removed: false });
  });

  it('重复卸载幂等', () => {
    installPluginBundle(bundle());
    uninstallPlugin('demo.role', '2.0.0');

    expect(uninstallPlugin('demo.role', '2.0.0')).toEqual({ removed: false });
  });

  it('只删指定版本，不动同 id 的其它版本', () => {
    installPluginBundle(bundle(rolePackFiles('demo.role', '2.0.0')));
    installPluginBundle(bundle(rolePackFiles('demo.role', '2.1.0')));

    uninstallPlugin('demo.role', '2.0.0');

    expect(installedDirs()).toEqual(['demo.role@2.1.0']);
  });
});

describe('removeRejectedPluginDir', () => {
  it('按目录名删掉一个没通过扫描的包目录', () => {
    // 这种目录进不了安装清单，没有 id@version 可以交给 uninstallPlugin
    const rogue = join(paths.pluginsDir, 'rogue@1.0.0');
    mkdirSync(rogue, { recursive: true });
    writeFileSync(join(rogue, 'manifest.json'), '{"id":"rogue"}', 'utf8');

    expect(removeRejectedPluginDir('rogue@1.0.0')).toEqual({ removed: true });
    expect(installedDirs()).toEqual([]);

    // 幂等：目录不在也算成功
    expect(removeRejectedPluginDir('rogue@1.0.0')).toEqual({ removed: false });
  });

  it('只删指定的那一个，不动旁边的插件目录', () => {
    installPluginBundle(bundle());
    const rogue = join(paths.pluginsDir, 'rogue@1.0.0');
    mkdirSync(rogue, { recursive: true });

    removeRejectedPluginDir('rogue@1.0.0');

    expect(installedDirs()).toEqual(['demo.role@2.0.0']);
  });

  it('渲染层只能传目录名：带路径的一律拒绝', () => {
    for (const bad of ['', '.', '..', '../elsewhere', 'a/b', 'a\\b']) {
      expect(() => removeRejectedPluginDir(bad), bad).toThrow('不合法的插件目录名');
    }
  });
});

/**
 * 默认插件：随安装包分发的软件工程岗位包。
 *
 * 老战役都挂在它上面，装不上就只剩只读；这一组用例守住「升级上来开箱就有」以及
 * 「它没有特殊身份——用户选了别的包就不该再回来」。
 */
describe('默认插件（软件工程岗位包）', () => {
  const SWE = DISTRIBUTED_ROLE_PACKS.find((pack) => pack.manifest.id === 'software-engineering')!;
  const INSTALLED = `software-engineering@${SWE.manifest.version}`;

  let bundleDir: string;
  let warn: MockInstance;

  beforeEach(() => {
    bundleDir = mkdtempSync(join(tmpdir(), 'openjob-default-plugin-'));
    // 装不上只记 warn：断言里要看它报的是哪一条原因，所以这里换成可捕获的桩
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    rmSync(bundleDir, { recursive: true, force: true });
  });

  /** 随包分发的那份 bundle，命名与 pack-plugins.mjs 的产物一致。 */
  function writeBundledPack(raw: Buffer = bundle(rolePackFiles(SWE.manifest.id, SWE.manifest.version, SWE))): void {
    writeFileSync(join(bundleDir, `${INSTALLED}.ojb`), raw);
  }

  it('本机没装任何岗位包时，把随包分发的那个装上', () => {
    writeBundledPack();

    ensureBundledDefaultPlugin([bundleDir]);

    expect(installedDirs()).toEqual([INSTALLED]);
  });

  /**
   * 包版本号不跟着包内容走（包内容迭代时不一定抬版本），所以同版本也要比内容：
   * 本机装着的是同版本的另一份内容时，用安装包里那份换上去。
   */
  it('同版本但本机那份内容不是安装包里那份时换上去', () => {
    writeBundledPack();
    installPluginBundle(
      bundle({
        ...rolePackFiles(SWE.manifest.id, SWE.manifest.version, SWE),
        'extra.txt': '来自别处的那一份',
      }),
    );

    ensureBundledDefaultPlugin([bundleDir]);

    expect(installedDirs()).toEqual([INSTALLED]);
    expect(existsSync(join(paths.pluginsDir, INSTALLED, 'extra.txt'))).toBe(false);
  });

  it('换过一次之后不再重写：内容没变就不动盘', () => {
    writeBundledPack();
    ensureBundledDefaultPlugin([bundleDir]);
    // 已装目录里放个标记：真被重写（先删目录再整体落盘）标记就不会还在
    writeFileSync(join(paths.pluginsDir, INSTALLED, 'marker.txt'), 'x');

    ensureBundledDefaultPlugin([bundleDir]);

    expect(existsSync(join(paths.pluginsDir, INSTALLED, 'marker.txt'))).toBe(true);
  });

  /**
   * 包内容是随包迭代的（页面声明、题型、量规、片段都写在包里），只装不升等于修好的东西永远
   * 送不到老用户手上：装着更老的版本时要升上去。
   */
  it('本机装着更老的版本时升上去，旧版本目录留着（老战役还 pin 着它）', () => {
    writeBundledPack();
    installPluginBundle(bundle(rolePackFiles(SWE.manifest.id, '0.9.0', SWE)));

    ensureBundledDefaultPlugin([bundleDir]);

    expect(installedDirs()).toEqual([`${SWE.manifest.id}@0.9.0`, INSTALLED].sort());
  });

  it('本机装着更新的版本时不倒着覆盖', () => {
    writeBundledPack();
    installPluginBundle(bundle(rolePackFiles(SWE.manifest.id, '2.0.0', SWE)));

    ensureBundledDefaultPlugin([bundleDir]);

    expect(installedDirs()).toEqual([`${SWE.manifest.id}@2.0.0`]);
  });

  it('用户已经装了别的岗位包时不抢位置：装不进去，但不抛错', () => {
    writeBundledPack();
    installPluginBundle(bundle(rolePackFiles('product-manager', '1.0.0')));

    expect(() => ensureBundledDefaultPlugin([bundleDir])).not.toThrow();

    expect(installedDirs()).toEqual(['product-manager@1.0.0']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('one-plugin-limit'));
  });

  it('没有随包分发的 bundle 时什么都不做（开发期没打包）', () => {
    ensureBundledDefaultPlugin([bundleDir]);

    expect(installedDirs()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('不是第一方签名的默认包不装：来源不可信就不该在启动路径上静默放行', () => {
    writeBundledPack(
      bundle(rolePackFiles(SWE.manifest.id, SWE.manifest.version, SWE), stranger, STRANGER_PEM),
    );

    ensureBundledDefaultPlugin([bundleDir]);

    expect(installedDirs()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('untrusted-signer'));
  });

  it('卸载之后不再装回来：默认不等于删不掉', () => {
    writeBundledPack();
    ensureBundledDefaultPlugin([bundleDir]);
    expect(installedDirs()).toEqual([INSTALLED]);

    uninstallPlugin(SWE.manifest.id, SWE.manifest.version);
    ensureBundledDefaultPlugin([bundleDir]);

    expect(installedDirs()).toEqual([]);
  });

  it('卸载的是别的包时不影响默认插件', () => {
    writeBundledPack();
    installPluginBundle(bundle(rolePackFiles('product-manager', '1.0.0')));
    uninstallPlugin('product-manager', '1.0.0');

    ensureBundledDefaultPlugin([bundleDir]);

    expect(installedDirs()).toEqual([INSTALLED]);
  });
});

/**
 * 覆盖清单变化的广播。
 *
 * 安装、卸载、删目录都经 loadExternalPlugins 重新装载，事件从那里统一发出，所以这里
 * 断言的是「真正落了盘、清单确实变了」才广播；装不进去（早退）时一次都不该发。
 */
describe('plugin:inventory-changed 广播', () => {
  const emitMock = vi.mocked(emit);

  beforeEach(() => {
    emitMock.mockClear();
  });

  it('装上第一个包后广播一次，带上装了几个包', () => {
    expect(installPluginBundle(bundle())).toMatchObject({ ok: true });

    expect(emitMock).toHaveBeenCalledWith('plugin:inventory-changed', { count: 1 });
  });

  it('卸载后广播清单变化', () => {
    installPluginBundle(bundle());
    emitMock.mockClear();

    uninstallPlugin('demo.role', '2.0.0');

    expect(emitMock).toHaveBeenCalledWith('plugin:inventory-changed', { count: 0 });
  });

  it('删掉一个没通过扫描的目录后广播清单变化', () => {
    mkdirSync(join(paths.pluginsDir, 'rogue@1.0.0'), { recursive: true });
    emitMock.mockClear();

    removeRejectedPluginDir('rogue@1.0.0');

    expect(emitMock).toHaveBeenCalledWith('plugin:inventory-changed', { count: 0 });
  });

  it('安装失败时不广播：装不进去就没有清单变化', () => {
    const broken = { ...rolePackFiles(), [PACKAGE_PACK_FILE]: '{"competencyTemplates":[]}' };

    expect(installPluginBundle(bundle(broken))).toMatchObject({ code: 'invalid-package' });

    expect(emitMock).not.toHaveBeenCalled();
  });

  it('启动扫描装载完成后也广播一次', () => {
    loadExternalPlugins();

    expect(emitMock).toHaveBeenCalledWith('plugin:inventory-changed', { count: 0 });
  });
});
