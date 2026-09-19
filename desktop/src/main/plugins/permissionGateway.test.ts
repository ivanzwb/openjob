import { describe, expect, it, vi } from 'vitest';
import type { PluginPermission } from '@core/plugins';

vi.mock('../db', () => ({
  getDb: vi.fn(),
  schema: {},
}));

import {
  DefaultDenyPermissionGateway,
  type CampaignCapabilityScope,
  type CapabilityRequest,
  type PermissionScopeProvider,
} from './permissionGateway';

const request: CapabilityRequest = {
  campaignId: 'campaign-a',
  capabilityId: 'source-repository',
  permission: 'artifact:read',
  resource: { kind: 'repository', id: 'repo-secret-a' },
};

const allowedScope: CampaignCapabilityScope = {
  campaignExists: true,
  capabilityEnabled: true,
  capabilityActive: true,
  resourceInScope: true,
};

function gateway(scope: CampaignCapabilityScope) {
  const resolve = vi.fn(() => scope);
  const provider: PermissionScopeProvider = { resolve };
  return {
    gateway: new DefaultDenyPermissionGateway(provider, () =>
      new Map([['source-repository', new Set(['artifact:read' as const])]]),
    ),
    resolve,
  };
}

describe('DefaultDenyPermissionGateway', () => {
  it('allows only the declared, active Campaign capability and resource', () => {
    const { gateway: subject } = gateway(allowedScope);

    expect(subject.authorize(request)).toEqual({
      allowed: true,
      campaignId: 'campaign-a',
      capabilityId: 'source-repository',
      permission: 'artifact:read',
    });
  });

  it('denies unknown Campaigns by default without exposing resource details', () => {
    const { gateway: subject } = gateway({
      ...allowedScope,
      campaignExists: false,
    });

    const decision = subject.authorize(request);

    expect(decision).toMatchObject({ allowed: false, code: 'campaign-not-found' });
    expect(JSON.stringify(decision)).not.toContain(request.resource.id);
  });

  it('distinguishes disabled and revoked capabilities', () => {
    expect(
      gateway({ ...allowedScope, capabilityEnabled: false }).gateway.authorize(request),
    ).toMatchObject({ allowed: false, code: 'capability-not-enabled' });
    expect(
      gateway({ ...allowedScope, capabilityActive: false }).gateway.authorize(request),
    ).toMatchObject({ allowed: false, code: 'permission-revoked' });
  });

  it('只看 descriptor 判能力是否启用，不看是哪个岗位包', () => {
    // 网关拿不到 rolePackId 是有意的：这里曾硬编码只放行 software-engineering，
    // 结果产品岗和销售岗装上的能力插件在真正取数据时全被拒
    expect(Object.keys(allowedScope)).not.toContain('rolePackId');

    const denied = gateway({ ...allowedScope, capabilityEnabled: false }).gateway.authorize(
      request,
    );
    expect(denied).toMatchObject({ allowed: false, code: 'capability-not-enabled' });
    expect(gateway(allowedScope).gateway.authorize(request).allowed).toBe(true);
  });

  it('rejects undeclared permissions before consulting Campaign state', () => {
    const { gateway: subject, resolve } = gateway(allowedScope);

    const decision = subject.authorize({
      ...request,
      permission: 'filesystem:workspace',
    });

    expect(decision).toMatchObject({ allowed: false, code: 'permission-undeclared' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('isolates resources between Campaigns', () => {
    const { gateway: subject } = gateway({
      ...allowedScope,
      resourceInScope: false,
    });

    const decision = subject.authorize(request);

    expect(decision).toMatchObject({ allowed: false, code: 'resource-out-of-scope' });
    expect(JSON.stringify(decision)).not.toContain('repo-secret-a');
  });
});

describe('DefaultDenyPermissionGateway.authorizePlugin（原语准入）', () => {
  /** 代码包原语契约按「包 id → 声明权限」注入；能力契约这里用不到，给空表。 */
  function pluginGateway(declared: Record<string, PluginPermission[]>) {
    return new DefaultDenyPermissionGateway(
      { resolve: () => allowedScope },
      () => new Map(),
      () => new Map(Object.entries(declared).map(([id, perms]) => [id, new Set(perms)])),
    );
  }

  it('声明了 filesystem:workspace 的代码包放行', () => {
    const subject = pluginGateway({ 'demo.pack': ['filesystem:workspace'] });
    expect(
      subject.authorizePlugin({ pluginId: 'demo.pack', permission: 'filesystem:workspace' }),
    ).toEqual({ allowed: true, pluginId: 'demo.pack', permission: 'filesystem:workspace' });
  });

  it('未声明的包与没装的包都被判 permission-undeclared', () => {
    const subject = pluginGateway({ 'demo.pack': ['artifact:read'] });
    expect(
      subject.authorizePlugin({ pluginId: 'demo.pack', permission: 'filesystem:workspace' }),
    ).toMatchObject({ allowed: false, code: 'permission-undeclared' });
    expect(
      subject.authorizePlugin({ pluginId: 'never.installed', permission: 'filesystem:workspace' }),
    ).toMatchObject({ allowed: false, code: 'permission-undeclared' });
  });
});
