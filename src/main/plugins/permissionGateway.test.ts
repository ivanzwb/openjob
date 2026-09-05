import { describe, expect, it, vi } from 'vitest';

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
  permission: 'repository:read',
  resource: { kind: 'repository', id: 'repo-secret-a' },
};

const allowedScope: CampaignCapabilityScope = {
  campaignExists: true,
  rolePackId: 'software-engineering',
  capabilityEnabled: true,
  capabilityActive: true,
  resourceInScope: true,
};

function gateway(scope: CampaignCapabilityScope) {
  const resolve = vi.fn(() => scope);
  const provider: PermissionScopeProvider = { resolve };
  return {
    gateway: new DefaultDenyPermissionGateway(
      provider,
      new Map([['source-repository', new Set(['repository:read' as const])]]),
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
      permission: 'repository:read',
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

  it('does not grant repository tools to a non-engineering Campaign', () => {
    const decision = gateway({
      ...allowedScope,
      rolePackId: 'product-manager',
    }).gateway.authorize(request);

    expect(decision).toMatchObject({
      allowed: false,
      code: 'capability-not-enabled',
    });
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
