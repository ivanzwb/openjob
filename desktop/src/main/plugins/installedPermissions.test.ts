/**
 * 权限契约按已安装 manifest 推导。
 *
 * 原来契约是内置数组算出来的常量，外置能力插件不管 manifest 写了什么，到网关都会被判成
 * permission-undeclared——表现是能力装上了、界面也开了，一取数据就失败，而错误信息说
 * 「插件没声明」，与事实相反。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  getDb: vi.fn(),
  schema: {},
}));

import { DISTRIBUTED_ROLE_PACKS } from '@plugins';
import { CORE_CAPABILITIES_PACK_ID } from '@core/plugins/capabilitySuite';
import type { PluginManifest, PluginPermission } from '@core/plugins';
import type { RolePack } from '@core/plugins/types';
import type { PluginInventoryEntry } from './inventory';
import {
  DefaultDenyPermissionGateway,
  installedPermissionContracts,
  type CampaignCapabilityScope,
} from './permissionGateway';
import { setExternalPlugins } from './runtime';

const OPEN_SCOPE: CampaignCapabilityScope = {
  campaignExists: true,
  capabilityEnabled: true,
  capabilityActive: true,
  resourceInScope: true,
};

const BASE_MANIFEST: PluginManifest = {
  id: 'demo.cap',
  version: '1.0.0',
  type: 'capability',
  displayName: 'Demo',
  description: 'Demo',
  compatibility: { core: '^1.0.0', schema: 1 },
  permissions: [],
  runtime: { desktop: 'full', mobile: 'full' },
};

function entry(overrides: Partial<PluginManifest>): PluginInventoryEntry {
  const manifest = { ...BASE_MANIFEST, ...overrides };
  return {
    dir: `/tmp/${manifest.id}@${manifest.version}`,
    trust: 'first-party',
    package: { manifest, contributions: { tools: [] } },
  };
}

function authorize(capabilityId: string, permission: PluginPermission) {
  const gateway = new DefaultDenyPermissionGateway(
    { resolve: () => OPEN_SCOPE },
    installedPermissionContracts,
  );
  return gateway.authorize({
    campaignId: 'campaign-a',
    capabilityId,
    permission,
    resource: { kind: 'repository', id: 'repo-a' },
  });
}

afterEach(() => {
  setExternalPlugins([]);
  vi.restoreAllMocks();
});

describe('installedPermissionContracts', () => {
  it('没装外置插件时契约为空（内置清单已清空）', () => {
    const contracts = installedPermissionContracts();

    expect([...contracts.keys()]).toEqual([]);
  });

  it('外置能力插件按自己 manifest 声明的权限受限', () => {
    setExternalPlugins([entry({ permissions: ['artifact:read'] })]);

    expect(authorize('demo.cap', 'artifact:read').allowed).toBe(true);
    expect(authorize('demo.cap', 'llm:complete')).toMatchObject({
      allowed: false,
      code: 'permission-undeclared',
    });
  });

  it('外置岗位包拿不到任何权限', () => {
    // 岗位包 permissions 恒为空，但契约还要按 type 过滤：漏了这层，
    // 以后有人给岗位包塞一个权限就会直接生效
    const source = structuredClone(DISTRIBUTED_ROLE_PACKS[0]!) as RolePack;
    const pack: RolePack = {
      ...source,
      manifest: { ...source.manifest, id: 'demo.role', version: '9.0.0', dependencies: [] },
    };
    setExternalPlugins([
      { dir: '/tmp/demo.role@9.0.0', trust: 'first-party', package: { manifest: pack.manifest, rolePack: pack } },
    ]);

    expect(installedPermissionContracts().has('demo.role')).toBe(false);
  });

  it('卸载之后权限立即失效', () => {
    setExternalPlugins([entry({ permissions: ['artifact:read'] })]);
    expect(authorize('demo.cap', 'artifact:read').allowed).toBe(true);

    setExternalPlugins([]);

    // 契约取快照的话，卸掉的插件权限还留着，这是最糟的方向
    expect(authorize('demo.cap', 'artifact:read')).toMatchObject({
      allowed: false,
      code: 'permission-undeclared',
    });
  });

  it('一个外置能力借不到另一个外置能力的权限', () => {
    // 合编包有 repository:read，不代表一个只声明 artifact:read 的外置包也能读仓库
    setExternalPlugins([entry({ permissions: [] })]);

    expect(authorize(CORE_CAPABILITIES_PACK_ID, 'repository:read').allowed).toBe(false);
    expect(authorize('demo.cap', 'repository:read')).toMatchObject({
      allowed: false,
      code: 'permission-undeclared',
    });
  });

  it('同 id 多版本且声明不一致时取交集，并告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setExternalPlugins([
      entry({ version: '1.0.0', permissions: ['artifact:read', 'llm:complete'] }),
      entry({ version: '2.0.0', permissions: ['artifact:read'] }),
    ]);

    // 契约按 id 索引（越权必须在读库之前被拒，拿不到 pin 的版本），
    // 歧义只能往窄的一边收：少给可恢复，多给不可逆
    expect(authorize('demo.cap', 'artifact:read').allowed).toBe(true);
    expect(authorize('demo.cap', 'llm:complete').allowed).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('同 id 多版本声明一致时不告警，权限照常', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setExternalPlugins([
      entry({ version: '1.0.0', permissions: ['artifact:read'] }),
      entry({ version: '2.0.0', permissions: ['artifact:read'] }),
    ]);

    expect(authorize('demo.cap', 'artifact:read').allowed).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('交集与版本注入顺序无关', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wide = entry({ version: '1.0.0', permissions: ['artifact:read', 'llm:complete'] });
    const narrow = entry({ version: '2.0.0', permissions: ['llm:complete'] });

    setExternalPlugins([wide, narrow]);
    const forward = [...(installedPermissionContracts().get('demo.cap') ?? [])].sort();
    setExternalPlugins([narrow, wide]);

    expect([...(installedPermissionContracts().get('demo.cap') ?? [])].sort()).toEqual(forward);
    expect(forward).toEqual(['llm:complete']);
  });

  it('没装的插件一律拒绝', () => {
    expect(authorize('never.installed', 'artifact:read')).toMatchObject({
      allowed: false,
      code: 'permission-undeclared',
    });
  });
});
