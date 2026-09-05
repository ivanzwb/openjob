import { and, desc, eq } from 'drizzle-orm';
import type { PluginPermission } from '@shared/plugins';
import {
  SOURCE_REPOSITORY_CAPABILITY_ID,
  sourceRepositoryCapabilityPlugin,
} from '@shared/plugins/builtin/sourceRepository';
import { getDb, schema } from '../db';

export interface CapabilityResource {
  kind: 'repository';
  id: string;
}

export interface CapabilityRequest {
  campaignId: string;
  capabilityId: string;
  permission: PluginPermission;
  resource: CapabilityResource;
}

export type PermissionDenialCode =
  | 'campaign-not-found'
  | 'capability-not-enabled'
  | 'permission-undeclared'
  | 'permission-revoked'
  | 'resource-out-of-scope';

export type PermissionDecision =
  | {
      allowed: true;
      campaignId: string;
      capabilityId: string;
      permission: PluginPermission;
    }
  | {
      allowed: false;
      code: PermissionDenialCode;
      /** Safe for logs/model context: never includes the requested resource or a local path. */
      message: string;
    };

export interface PermissionGateway {
  authorize(request: CapabilityRequest): PermissionDecision;
}

export interface CampaignCapabilityScope {
  campaignExists: boolean;
  rolePackId: string | null;
  capabilityEnabled: boolean;
  capabilityActive: boolean;
  resourceInScope: boolean;
}

export interface PermissionScopeProvider {
  resolve(request: CapabilityRequest): CampaignCapabilityScope;
}

type CapabilityPermissionContracts = ReadonlyMap<string, ReadonlySet<PluginPermission>>;

const SAFE_DENIAL_MESSAGES: Record<PermissionDenialCode, string> = {
  'campaign-not-found': 'Campaign permission scope is unavailable.',
  'capability-not-enabled': 'Capability is not enabled for this Campaign.',
  'permission-undeclared': 'Capability did not declare the requested permission.',
  'permission-revoked': 'Capability permission has been revoked.',
  'resource-out-of-scope': 'Resource is outside the Campaign permission scope.',
};

function deny(code: PermissionDenialCode): PermissionDecision {
  return { allowed: false, code, message: SAFE_DENIAL_MESSAGES[code] };
}

export class DefaultDenyPermissionGateway implements PermissionGateway {
  constructor(
    private readonly scopes: PermissionScopeProvider,
    private readonly contracts: CapabilityPermissionContracts,
  ) {}

  authorize(request: CapabilityRequest): PermissionDecision {
    const declared = this.contracts.get(request.capabilityId);
    if (!declared?.has(request.permission)) return deny('permission-undeclared');

    const scope = this.scopes.resolve(request);
    if (!scope.campaignExists) return deny('campaign-not-found');
    if (
      scope.rolePackId !== 'software-engineering' ||
      !scope.capabilityEnabled
    ) {
      return deny('capability-not-enabled');
    }
    if (!scope.capabilityActive) return deny('permission-revoked');
    if (!scope.resourceInScope) return deny('resource-out-of-scope');

    return {
      allowed: true,
      campaignId: request.campaignId,
      capabilityId: request.capabilityId,
      permission: request.permission,
    };
  }
}

class DatabasePermissionScopeProvider implements PermissionScopeProvider {
  resolve(request: CapabilityRequest): CampaignCapabilityScope {
    const db = getDb();
    const campaign = db
      .select({ id: schema.campaign.id })
      .from(schema.campaign)
      .where(eq(schema.campaign.id, request.campaignId))
      .get();
    if (!campaign) {
      return {
        campaignExists: false,
        rolePackId: null,
        capabilityEnabled: false,
        capabilityActive: false,
        resourceInScope: false,
      };
    }

    const descriptor = db
      .select()
      .from(schema.campaignRuntimeDescriptor)
      .where(eq(schema.campaignRuntimeDescriptor.campaignId, request.campaignId))
      .orderBy(desc(schema.campaignRuntimeDescriptor.revision))
      .get();
    const capability = descriptor?.capabilities.find(
      (item) => item.id === request.capabilityId,
    );
    const capabilityEnabled = capability?.enabled === true;

    const binding = db
      .select({
        activeExecution: schema.campaignPluginBinding.activeExecution,
      })
      .from(schema.campaignPluginBinding)
      .where(
        and(
          eq(schema.campaignPluginBinding.campaignId, request.campaignId),
          eq(schema.campaignPluginBinding.pluginId, request.capabilityId),
        ),
      )
      .orderBy(desc(schema.campaignPluginBinding.revision))
      .get();

    const linkedTask = db
      .select({ id: schema.task.id })
      .from(schema.task)
      .innerJoin(schema.planDay, eq(schema.task.planDayId, schema.planDay.id))
      .where(
        and(
          eq(schema.planDay.campaignId, request.campaignId),
          eq(schema.task.repoId, request.resource.id),
        ),
      )
      .get();

    return {
      campaignExists: true,
      rolePackId: descriptor?.rolePack.id ?? null,
      capabilityEnabled,
      capabilityActive: binding?.activeExecution === true,
      resourceInScope: request.resource.kind === 'repository' && Boolean(linkedTask),
    };
  }
}

const BUILT_IN_PERMISSION_CONTRACTS: CapabilityPermissionContracts = new Map([
  [
    SOURCE_REPOSITORY_CAPABILITY_ID,
    new Set(sourceRepositoryCapabilityPlugin.manifest.permissions),
  ],
]);

export const permissionGateway: PermissionGateway = new DefaultDenyPermissionGateway(
  new DatabasePermissionScopeProvider(),
  BUILT_IN_PERMISSION_CONTRACTS,
);

export class PermissionDeniedError extends Error {
  constructor(readonly decision: Extract<PermissionDecision, { allowed: false }>) {
    super(`Repository tool access denied (${decision.code}).`);
    this.name = 'PermissionDeniedError';
  }
}
