/**
 * 临时端到端验证（阅后即删）：四个 release 附件按真实安装链路装载后，
 * 目录落位、岗位包可解析、能力绑定指向合编包、清单不再有「随应用发布」。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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
import { synthesizeSuiteFromRolePack } from '@core/plugins/capabilitySuite';
import { softwareEngineeringRolePack } from '@plugins/softwareEngineering';

const coreCapabilitiesSuite = synthesizeSuiteFromRolePack(softwareEngineeringRolePack)!;
import { signPackageFiles, toBundleJson } from './bundle';
import { installPluginBundle } from './install';
import { listInstalledPlugins, setExternalPlugins, findInstalledRolePack } from './runtime';
import { loadExternalPlugins } from './bootstrap';


// 签名与信任用同一把钥匙（mock 的第一方公钥就是它）
const publisher = { privateKey: keys.privateKey };
const PUBLISHER_PEM = keys.publisherPem;

let DIST = '';

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
  it('四个附件全部装得上，能力包承载全部能力，清单没有随应用发布', () => {
    // 重打四个附件（与 CI 同一函数），本测试只关心它们装得上
    const files = [
      ...DISTRIBUTED_ROLE_PACKS.map((pack) => ({
        name: `${pack.manifest.id}@${pack.manifest.version}.openjob.json`,
        files: (() => {
          const { manifest, ...rest } = pack;
          return {
            'manifest.json': JSON.stringify(manifest),
            'pack.json': JSON.stringify(rest),
          };
        })(),
      })),
      {
        name: `${coreCapabilitiesSuite.manifest.id}@${coreCapabilitiesSuite.manifest.version}.openjob.json`,
        files: {
          'manifest.json': JSON.stringify(coreCapabilitiesSuite.manifest),
          'contributions.json': JSON.stringify(
            (() => {
              const c: { tools: unknown[]; artifactParsers: unknown[]; interactions: unknown[] } = {
                tools: [], artifactParsers: [], interactions: [],
              };
              coreCapabilitiesSuite.register({
                registerTool: (t) => c.tools.push(t),
                registerArtifactParser: (p) => c.artifactParsers.push(p),
                registerInteractionType: (i) => c.interactions.push(i),
              });
              return c;
            })(),
          ),
        },
      },
    ];
    for (const { name, files: packageFiles } of files) {
      const signed = signPackageFiles(packageFiles, publisher.privateKey, PUBLISHER_PEM);
      writeFileSync(join(DIST, name), toBundleJson(signed), 'utf8');
    }

    const bundles = readdirSync(DIST).filter((f) => f.endsWith('.openjob.json'));
    expect(bundles).toHaveLength(4);
    for (const name of bundles) {
      const result = installPluginBundle(readFileSync(join(DIST, name)), {});
      if (!result.ok) throw new Error(`安装失败 ${name}: ${result.code}`);
    }

    // 扫描装载（与启动同一条入口）
    loadExternalPlugins();

    // 清单里没有「随应用发布」：全部都是 first-party 外置包。
    // 插入点 E：带内嵌声明的岗位包按版本合并出一条合成套件条目（3 包 + 旧套件 + 合成 = 5）
    const installed = listInstalledPlugins();
    expect(installed).toHaveLength(6);
    expect(installed.map((p) => p.id)).toContain('openjob-capabilities');
    expect(installed.map((p) => p.id)).not.toContain('source-repository');

    // 三个岗位包都能按精确 id@version 解析
    for (const pack of DISTRIBUTED_ROLE_PACKS) {
      expect(findInstalledRolePack(pack.manifest.id, pack.manifest.version)).not.toBeNull();
    }

    // 套件附件由 SE 声明合成（版本随包），权限 = SE 内嵌能力
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
  });
});
