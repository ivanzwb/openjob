/**
 * release 附件的真实安装/扫描链路：三个岗位包按真实安装入口装完即能解析，
 * 升级前装着多个包的机器扫盘照常装载；能力条目由岗位包内嵌声明在运行时合成，
 * 不随 release 单独分发，清单里也没有「随应用发布」的内置条目。
 */import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as nodeCrypto from 'node:crypto';

const keys = vi.hoisted(() => {
  // vi.hoisted 在静态 import 求值之前执行，块内用不了顶层 import 绑定；
  // node:crypto 是内建模块，require 是 vitest 对这种场景的标准写法。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { generateKeyPairSync } = require('node:crypto') as typeof nodeCrypto;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publisherPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
});

// 与 install.test 并行跑时会争抢真实的 resources/plugin-keys.json（那边写完就删），
// 这里 mock 掉密钥解析：本测试的签名者就是第一方，不依赖共享文件系统
vi.mock('./package/trustedKeys', () => ({
  loadTrustedPublicKeys: () => [keys.publisherPem],
}));

const paths = { userData: '', pluginsDir: '' };
vi.mock('../paths', () => ({ getAppPaths: () => paths }));

import { DISTRIBUTED_ROLE_PACKS } from '@plugins';
import {
  PACKAGE_MANIFEST_FILE,
  PACKAGE_PACK_FILE,
  type PluginPackageFiles,
} from '@core/plugins/package/contract';
import { synthesizeSuiteFromRolePack } from '@core/plugins/capabilitySuite';
import { softwareEngineeringRolePack } from '@plugins/softwareEngineering';

const coreCapabilitiesSuite = synthesizeSuiteFromRolePack(softwareEngineeringRolePack)!;
import { signPackageFiles, toBundleJson } from './bundle';
import { installPluginBundle, uninstallPlugin } from './install';
import { listExternalPlugins, listInstalledPlugins, setExternalPlugins, findInstalledRolePack } from './runtime';
import { loadExternalPlugins, pluginInventoryView } from './bootstrap';


// 签名与信任用同一把钥匙（mock 的第一方公钥就是它）
const publisher = { privateKey: keys.privateKey };
const PUBLISHER_PEM = keys.publisherPem;

let DIST = '';

/**
 * 直接把包目录铺到安装位置。
 *
 * 走的是扫描路径而不是安装入口——「一台设备只装一个插件」之后，安装入口到不了
 * 「多个包同时在场」这个状态，而存量机器就是这样，扫描必须照常装载它们。
 */
function layDownPackage(dirName: string, files: PluginPackageFiles): void {
  const dir = join(paths.pluginsDir, dirName);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf8');
  }
}

/** 重打三个 release 附件（与 CI 同一函数），内容取自仓库里的分发数据。 */
function releaseAttachments(): Array<{ name: string; files: PluginPackageFiles }> {
  return DISTRIBUTED_ROLE_PACKS.map((pack) => {
    const { manifest, ...rest } = pack;
    const files: PluginPackageFiles = {
      [PACKAGE_MANIFEST_FILE]: JSON.stringify(manifest),
      [PACKAGE_PACK_FILE]: JSON.stringify(rest),
    };
    return {
      name: `${manifest.id}@${manifest.version}.openjob.json`,
      files: signPackageFiles(files, publisher.privateKey, PUBLISHER_PEM),
    };
  });
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'openjob-e2e-'));
  paths.userData = root;
  paths.pluginsDir = join(root, 'plugins');
  // 分发附件写到临时目录：模拟用户从 release 页下载到本地的那份
  DIST = join(root, 'downloads');
  mkdirSync(DIST, { recursive: true });

});

afterEach(() => {
  rmSync(paths.userData, { recursive: true, force: true });
  setExternalPlugins([]);
});

describe('release 附件端到端', () => {
  it('三个附件都能装，装完就能解析', () => {
    for (const { name, files } of releaseAttachments()) {
      // 信封写到临时目录：模拟用户从 release 页下载到本地的那份
      writeFileSync(join(DIST, name), toBundleJson(files), 'utf8');
    }

    const bundles = readdirSync(DIST).filter((f) => f.endsWith('.openjob.json'));
    expect(bundles).toHaveLength(3);

    // 一个设备只装一个插件：逐个装、逐个验，装下一个之前先卸掉上一个
    for (const name of bundles) {
      const result = installPluginBundle(readFileSync(join(DIST, name)), {});
      if (!result.ok) throw new Error(`安装失败 ${name}: ${result.code}`);

      const key = name.replace(/\.openjob\.json$/, '');
      const entry = listExternalPlugins().find(
        (item) => `${item.package.manifest.id}@${item.package.manifest.version}` === key,
      );
      expect(entry, `${key} 装上之后不在装载清单里`).toBeDefined();

      // 清单里没有「随应用发布」的内置条目：装上去的这条就是全部来源
      const ids = listInstalledPlugins().map((plugin) => plugin.id);
      expect(ids).not.toContain('source-repository');
      expect(ids).toContain(entry!.package.manifest.id);

      // 岗位包装上就能按精确 id@version 解析
      if (entry!.package.manifest.type === 'role-pack') {
        expect(
          findInstalledRolePack(entry!.package.manifest.id, entry!.package.manifest.version),
        ).not.toBeNull();
      }

      const { id, version } = entry!.package.manifest;
      uninstallPlugin(id, version);
    }
  });

  it('升级前留下的多个插件包全部照常装载：限制挡的是新安装', () => {
    // 铺目录而不是走安装入口：一台在「只装一个」之前就装过几个包的机器，盘面就是这样。
    // 升级上来必须照常可用——这条限制只该挡住「再装一个」，不该让已有插件失效。
    // 安装路径已经到不了这个状态（见上一个用例），扫描路径才是它的来处。
    for (const { name, files } of releaseAttachments()) {
      layDownPackage(name.replace(/\.openjob\.json$/, ''), files);
    }

    // 扫描装载（与启动同一条入口）
    loadExternalPlugins();

    // 清单里没有「随应用发布」：全部都是 first-party 外置包。
    // 插入点 E：带内嵌声明的岗位包按版本合出合成套件条目
    // （3 个岗位包 + 1.4.0 / 1.3.0 两条合成 = 5），它不占 release 附件
    const installed = listInstalledPlugins();
    expect(installed).toHaveLength(5);
    expect(installed.map((p) => p.id)).toContain('openjob-capabilities');
    expect(installed.map((p) => p.id)).not.toContain('source-repository');

    // 三个岗位包都能按精确 id@version 解析
    for (const pack of DISTRIBUTED_ROLE_PACKS) {
      expect(findInstalledRolePack(pack.manifest.id, pack.manifest.version)).not.toBeNull();
    }

    // 合成条目由 SE 声明合出来（版本随包），权限 = SE 内嵌能力
    const suite = installed.find(
      (p) => p.id === 'openjob-capabilities' && p.version === coreCapabilitiesSuite.manifest.version,
    );
    expect(suite!.permissions.sort()).toEqual(['repository:read']);
    // 合成条目按包版本存在：每个版本的权限 = 该版本岗位包内嵌能力的并集
    for (const pack of DISTRIBUTED_ROLE_PACKS) {
      if (!pack.manifest.main) continue;
      const inline = installed.find(
        (p) => p.id === 'openjob-capabilities' && p.version === pack.manifest.version,
      );
      expect(inline, `缺少 ${pack.manifest.id} 版本的合成条目`).toBeDefined();
      expect(inline!.permissions.length).toBeGreaterThan(0);
    }
    // 软件工程包的合成条目只带 repository:read（它只内嵌了源码能力）
    const seInline = installed.find(
      (p) =>
        p.id === 'openjob-capabilities' &&
        p.version === '1.4.0',
    );
    expect(seInline!.permissions).toEqual(['repository:read']);

    // 设置页的「已装」列表只看盘上有什么：合成条目不是用户装的包（它的内容本来就归岗位包
    // 所有），列出来会让「装一个包」看起来像装了两个
    const view = pluginInventoryView();
    expect(view.installed.map((item) => `${item.id}@${item.version}`)).toEqual([
      'product-manager@1.3.0',
      'sales-customer-success@1.3.0',
      'software-engineering@1.4.0',
    ]);
    expect(view.installed.map((item) => item.displayName)).toContain('软件工程');
    expect(view.installed.find((item) => item.id === 'software-engineering')?.main).toBe('main.js');
    expect(view.rejected).toEqual([]);
  });
});
