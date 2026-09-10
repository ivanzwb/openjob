import { and, desc, eq } from 'drizzle-orm';
import type { PluginPermission } from '@core/plugins';
import { BUILT_IN_CAPABILITY_PLUGINS } from '@core/plugins/builtin';
import { getDb, schema } from '../db';
import { listInstalledPlugins } from './runtime';

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

/**
 * 授权判断需要的全部事实。
 *
 * 刻意不含 rolePackId：网关一旦看得见岗位包，就会有人写出「只有工程岗能用」
 * 这种判断（v1.0 之前正是如此，于是产品岗和销售岗的能力插件全被拒），而某个
 * 能力在某个 Campaign 里能不能用，descriptor 已经判过了，再判一次只会判错。
 */
export interface CampaignCapabilityScope {
  campaignExists: boolean;
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
  /**
   * contracts 是取值函数而不是快照：外置插件可以在运行期装上或卸掉，快照会让刚装好的
   * 能力一直被判成「没声明」，或者更糟——卸掉之后权限还在。
   */
  constructor(
    private readonly scopes: PermissionScopeProvider,
    private readonly contracts: () => CapabilityPermissionContracts,
  ) {}

  authorize(request: CapabilityRequest): PermissionDecision {
    const declared = this.contracts().get(request.capabilityId);
    if (!declared?.has(request.permission)) return deny('permission-undeclared');

    const scope = this.scopes.resolve(request);
    if (!scope.campaignExists) return deny('campaign-not-found');
    if (!scope.capabilityEnabled) return deny('capability-not-enabled');
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
    const capabilityVersion = capability?.version;

    const binding = capabilityVersion
      ? db
          .select({
            activeExecution: schema.campaignPluginBinding.activeExecution,
          })
          .from(schema.campaignPluginBinding)
          .where(
            and(
              eq(schema.campaignPluginBinding.campaignId, request.campaignId),
              eq(schema.campaignPluginBinding.pluginId, request.capabilityId),
              eq(schema.campaignPluginBinding.pluginVersion, capabilityVersion),
              eq(schema.campaignPluginBinding.revision, descriptor!.revision),
            ),
          )
          .get()
      : undefined;

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
      capabilityEnabled,
      capabilityActive: binding?.activeExecution === true,
      resourceInScope: request.resource.kind === 'repository' && Boolean(linkedTask),
    };
  }
}

/**
 * 每个能力插件申请的权限就是它的上限，由内置清单直接推导。
 *
 * 原来这里只手写了 source-repository 一项：新能力插件即使在 Manifest 里声明了
 * 权限，到网关这一层也会被判成 permission-undeclared——表现是能力装上了、
 * 界面也开了，一到真正取数据就失败，而错误信息指向「插件没声明」，与事实相反。
 */
export const BUILT_IN_PERMISSION_CONTRACTS: CapabilityPermissionContracts = new Map(
  BUILT_IN_CAPABILITY_PLUGINS.map((plugin) => [
    plugin.manifest.id,
    new Set(plugin.manifest.permissions),
  ]),
);

/**
 * 按**本机已安装**的能力插件推导契约，内置与外置同一条规则。
 *
 * 外置插件凭 manifest 拿权限，是因为装它这件事本身就是用户的授权动作：包必须验签通过，
 * 非第一方签名还要显式确认，确认界面上列的就是这份权限清单（P06/P07）。网关这一层管的
 * 是「不许超出声明」和「不许越出本 Campaign 的资源范围」，不是「该不该装」。
 *
 * 同一个 id 装了多个版本时取**交集**。契约按 id 索引（不带版本），因为越权必须在读库之前
 * 就被拒——拿到 descriptor 里 pin 的版本得先查库，那就等于让未授权的调用方也能触发一次
 * 数据库访问。既然拿不到版本，歧义只能往窄的一边收：少给会表现成一次可见的拒绝，用户
 * 卸掉旧版本就恢复；多给是不可逆的。
 */
export function installedPermissionContracts(): CapabilityPermissionContracts {
  const contracts = new Map<string, Set<PluginPermission>>();
  const ambiguous = new Set<string>();

  for (const plugin of listInstalledPlugins()) {
    if (plugin.type !== 'capability') continue;
    const declared = new Set(plugin.permissions);
    const existing = contracts.get(plugin.id);
    if (!existing) {
      contracts.set(plugin.id, declared);
      continue;
    }
    for (const permission of existing) {
      if (!declared.has(permission)) {
        existing.delete(permission);
        ambiguous.add(plugin.id);
      }
    }
    for (const permission of declared) {
      if (!existing.has(permission)) ambiguous.add(plugin.id);
    }
  }

  if (ambiguous.size > 0) {
    console.warn(
      '以下能力插件装了多个版本且权限声明不一致，已按交集授权：',
      [...ambiguous].sort(),
    );
  }
  return contracts;
}

export const permissionGateway: PermissionGateway = new DefaultDenyPermissionGateway(
  new DatabasePermissionScopeProvider(),
  installedPermissionContracts,
);

export class PermissionDeniedError extends Error {
  constructor(readonly decision: Extract<PermissionDecision, { allowed: false }>) {
    super(`Repository tool access denied (${decision.code}).`);
    this.name = 'PermissionDeniedError';
  }
}
