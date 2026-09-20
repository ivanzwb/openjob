/**
 * Campaign 运行时读写的唯一入口。
 *
 * 插件依赖解析只在这里发生一次，写库后由 descriptor 承担跨端事实源；
 * 桌面渲染层和手机端都只消费 descriptor，再各自计算本机降级视图。
 *
 * 唯一的例外是「有岗位画像、却还没有 descriptor」的战役：读 getCampaignRuntime 时顺手
 * 补一次解析，让画像立刻生效（见 resolvePendingRoleProfile）。既没有画像、也没有
 * pre-plugin 凭据的旧战役读路径一行都不写，保持升级前的行为。
 *
 * 本模块不引用 ../db：所有函数接收 raw Database，由 IPC/RPC 层注入，
 * 这样迁移后的真实库结构可以直接进单测。
 */
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type {
  CampaignRuntimeView,
  ClientCapabilityViewRequest,
  SetRoleProfileInput,
} from '@core/ipc';
import { capabilityEntriesFromRolePack } from '@core/plugins/capabilityEntries';
import type { LlmRoleContribution } from '@core/llm/roles';
import {
  buildClientCapabilityView,
  listBuiltInPlugins,
  toInstalledPlugin,
  type ClientCapabilityView,
  type InstalledPlugin,
} from '@core/plugins/clientView';
import { toCapabilityPlugin } from '@core/plugins/package/replay';
import { BuiltInPluginRegistry } from '@core/plugins/registry';
import { DeterministicRuntimeResolver } from '@core/plugins/resolver';
import type {
  CampaignRuntimeDescriptor,
  ResolvedCapabilityRef,
  ResolvedPluginRef,
  RolePack,
} from '@core/plugins/types';
import type { RoleProfile } from '@core/entities';

import type { PluginInventoryEntry } from './inventory';

/** descriptor 写入用的核心版本与 schema 版本（当前值）。 */
export const CORE_VERSION = '1.0.0';
export const RUNTIME_SCHEMA_VERSION = 25;

interface DescriptorRow {
  revision: number;
  core_version: string;
  role_pack: string;
  industry_variant_id: string | null;
  capabilities: string;
  competency_baseline_version: string;
  config_snapshot_hash: string;
  resolved_at: number;
}

interface RoleProfileRow {
  id: string;
  role_family: string;
  role_pack_id: string;
  level: string | null;
  industry_variant_id: string | null;
  location: string | null;
  interview_language: string;
  confidence: number;
  user_confirmed: number;
}

/**
 * 本机装了的外置插件。
 *
 * 模块级可变状态是刻意的：扫描要碰文件系统，不能发生在本模块（它被单测直接加载，
 * 而且刻意不依赖 ../db 与 electron）。启动流程扫完之后调 setExternalPlugins 注入。
 */
let externalEntries: readonly PluginInventoryEntry[] = [];

/**
 * 外置包装配进注册表，走的是与内置完全相同的契约入口。
 *
 * 岗位包直接就是数据；能力插件把录下来的声明重放一遍（见 package/replay.ts），
 * 全程不执行任何外部代码。
 */
function registerExternal(registry: BuiltInPluginRegistry, entry: PluginInventoryEntry): void {
  const { manifest, rolePack, contributions } = entry.package;
  // 按 manifest.type 分派，而不是按哪个字段有值：两者本该一致（格式校验强制 type 与文件
  // 对应），真不一致时应当明确报错，而不是让 type 与实际注册方式静默分叉
  switch (manifest.type) {
    case 'role-pack':
      if (!rolePack) throw new Error(`岗位包缺少数据：${manifest.id}`);
      registry.register(rolePack);
      return;
    case 'capability':
      if (!contributions) throw new Error(`能力插件缺少 contributions：${manifest.id}`);
      registry.registerCapability(toCapabilityPlugin(manifest, contributions));
      return;
    case 'plugin':
      // 代码插件（§7.9）：声明面为空，激活由渲染层运行时负责，数据注册表无需登记
      return;
  }
}

function createRegistry(): BuiltInPluginRegistry {
  const registry = new BuiltInPluginRegistry();
  // 基础包不再内置任何插件：岗位包由用户安装，能力随岗位包的内嵌声明派生。
  // 这里只装配本机安装清单，注册顺序即扫描顺序。
  externalEntries.forEach((entry) => registerExternal(registry, entry));
  return registry;
}

let registry = createRegistry();
let resolver = new DeterministicRuntimeResolver(registry);

/**
 * 已装岗位包为某个能力声明的第一个 LLM 角色；没装或没声明返回 undefined。
 *
 * 宿主只按能力 id 取声明，不认识任何具体角色名——角色名与用途都写在岗位包的
 * 能力声明里（CapabilityDeclaration.llmRoles）。返回 undefined 时调用方按
 * 「未声明角色」处理，最终落 main 档。
 *
 * 只认岗位包：v3 起声明归岗位包所有，独立能力包已不再随 release 分发。
 */
export function declaredLlmRole(capabilityId: string): string | undefined {
  for (const entry of externalEntries) {
    for (const declaration of entry.package.rolePack?.capabilities ?? []) {
      if (declaration.id !== capabilityId) continue;
      const role = declaration.llmRoles?.[0];
      if (role) return role.name;
    }
  }
  return undefined;
}

/** 本机已装岗位包声明的全部角色，供设置页的「角色映射」展示。 */
export function declaredLlmRoles(): LlmRoleContribution[] {
  const contributions: LlmRoleContribution[] = [];
  for (const entry of externalEntries) {
    const pack = entry.package.rolePack;
    if (!pack) continue;
    for (const declaration of pack.capabilities ?? []) {
      for (const role of declaration.llmRoles ?? []) {
        contributions.push({ role, pluginId: pack.manifest.id });
      }
    }
  }
  return contributions;
}

/**
 * 替换外置插件集合并重建解析器。
 *
 * 整体重建而不是增量往注册表里塞：BuiltInPluginRegistry 不允许同 id@version 覆盖，
 * 增量注册在「卸载后重装」时必然撞车，而且解析结果会依赖注册顺序。
 */
export function setExternalPlugins(entries: readonly PluginInventoryEntry[]): void {
  externalEntries = [...entries];
  registry = createRegistry();
  resolver = new DeterministicRuntimeResolver(registry);
}

/**
 * 按精确版本取本机已安装的岗位包，没装返回 null。
 *
 * 走注册表而不是自己遍历 externalEntries：注册表是解析用的同一份集合，两处各查一遍时，
 * 「能选上但练不了」这类分叉会在最难查的地方出现——岗位选好了、descriptor 也写了，
 * 到出题那一步才说没这个包。
 */
export function findInstalledRolePack(id: string, version: string): RolePack | null {
  return registry.get(id, version);
}

/**
 * 同 id 的最新已装版本（不限 descriptor pin 的版本）。
 *
 * 供排程使用：descriptor pin 的精确版本只对练习有意义（量规必须逐字一致）；
 * 排程要回答的是「现在装着的这个包还排不排源码任务」，用最新版本才符合直觉。
 */
export function findLatestRolePack(id: string): RolePack | null {
  return registry.get(id);
}

/**
 * 本机装着的岗位包（各自带着声明的检索策略等）。
 *
 * 设置页展示生效策略时用：一台设备只装一个岗位包，所以不需要先选战役。与按战役取自
 * descriptor 的那条路并存——那边回答「这场备考用什么策略」，这边回答「本机现在的岗位
 * 是什么策略」，而设置页问的正是后者。
 */
export function listInstalledRolePacks(): RolePack[] {
  return externalEntries.flatMap((entry) => (entry.package.rolePack ? [entry.package.rolePack] : []));
}

export function listExternalPlugins(): readonly PluginInventoryEntry[] {
  return externalEntries;
}

/**
 * 本机安装清单：随应用发布的部分 + 用户装的包 + 这些包内嵌声明派生的能力。
 *
 * 能力不是独立的包，所以这里按**每条声明**派生一条能力条目（id = 能力自己的 id、版本随
 * 岗位包）——clientView 判定「这个能力本机有没有」、权限网关推导契约都靠它。清单里不会
 * 出现任何合成包 id。
 */
export function listInstalledPlugins(): InstalledPlugin[] {
  const capabilities = externalEntries.flatMap((entry) =>
    entry.package.rolePack ? capabilityEntriesFromRolePack(entry.package.rolePack) : [],
  );
  const packs = externalEntries.map((entry) => {
    const installed = toInstalledPlugin(entry.package.manifest);
    // 行业变体是岗位包内的声明，随包一起进清单——界面按选中岗位包取选项
    const variants = entry.package.rolePack?.industryVariants;
    return variants && variants.length > 0 ? { ...installed, industryVariants: variants } : installed;
  });
  return [
    ...listBuiltInPlugins(),
    ...packs,
    ...capabilities,
  ].sort(
    (left, right) =>
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0) ||
      (left.version < right.version ? -1 : left.version > right.version ? 1 : 0),
  );
}

function rowToRoleProfile(row: RoleProfileRow): RoleProfile {
  return {
    id: row.id,
    roleFamily: row.role_family,
    rolePackId: row.role_pack_id,
    level: row.level,
    industryVariantId: row.industry_variant_id,
    location: row.location,
    interviewLanguage: row.interview_language,
    confidence: row.confidence,
    userConfirmed: row.user_confirmed === 1,
  };
}

function readRoleProfile(raw: Database, campaignId: string): RoleProfile | null {
  const row = raw
    .prepare(
      `SELECT p.* FROM role_profile p
       JOIN campaign c ON c.role_profile_id = p.id
       WHERE c.id = ?`,
    )
    .get(campaignId) as RoleProfileRow | undefined;
  return row ? rowToRoleProfile(row) : null;
}

function readDescriptor(raw: Database, campaignId: string): CampaignRuntimeView | null {
  const row = raw
    .prepare(
      `SELECT revision, core_version, role_pack, industry_variant_id, capabilities,
              competency_baseline_version, config_snapshot_hash, resolved_at
       FROM campaign_runtime_descriptor
       WHERE campaign_id = ?
       ORDER BY revision DESC
       LIMIT 1`,
    )
    .get(campaignId) as DescriptorRow | undefined;
  if (!row) return null;

  const descriptor: CampaignRuntimeDescriptor = {
    campaignId,
    coreVersion: row.core_version,
    rolePack: JSON.parse(row.role_pack) as ResolvedPluginRef,
    industryVariantId: row.industry_variant_id ?? undefined,
    capabilities: JSON.parse(row.capabilities) as ResolvedCapabilityRef[],
    competencyBaselineVersion: row.competency_baseline_version,
    configSnapshotHash: row.config_snapshot_hash,
    resolvedAt: row.resolved_at,
  };
  return { descriptor, revision: row.revision, roleProfile: readRoleProfile(raw, campaignId) };
}

/**
 * 已有岗位画像、却还没有 descriptor 的战役：补一次解析并返回结果。
 *
 * 画像可能先于运行时落库（例如诊断先给出岗位画像、或旧库只把画像同步了过来），
 * 这时不能让用户先打开岗位面板才生效——读 runtime 的这条路径顺手把解析补上。
 * 画像的确认状态原样带过去：自动解析不是用户的选择，不冒充「已确认」。
 *
 * 解析失败（岗位包本机没装等）时返回 null，让调用方照旧走「没有运行配置」的分支；
 * 这条路径只对**有画像**的战役动手，既没画像也没 pre-plugin 凭据的旧战役读路径
 * 依旧一行都不写。
 */
function resolvePendingRoleProfile(raw: Database, campaignId: string): CampaignRuntimeView | null {
  const profile = readRoleProfile(raw, campaignId);
  if (!profile) return null;
  try {
    return setCampaignRoleProfile(raw, {
      campaignId,
      roleFamily: profile.roleFamily,
      rolePackId: profile.rolePackId,
      level: profile.level,
      industryVariantId: profile.industryVariantId,
      location: profile.location,
      interviewLanguage: profile.interviewLanguage,
      confidence: profile.confidence,
      userConfirmed: profile.userConfirmed,
    });
  } catch {
    // 岗位包卸了、版本对不上等：读路径不该抛，交回「没有 descriptor」的现状
    return null;
  }
}

export function getCampaignRuntime(
  raw: Database,
  campaignId: string,
): CampaignRuntimeView | null {
  const existing = readDescriptor(raw, campaignId);
  if (existing) return existing;
  // 有画像无 descriptor：读路径上补解析，画像立刻生效，不必等用户打开面板
  return resolvePendingRoleProfile(raw, campaignId);
}

export interface SetRoleProfileOptions {
  now?: () => number;
}

/**
 * 写入岗位意图并激活新的 binding revision。
 *
 * 解析失败时不写任何一行：Campaign 保留上一份有效 descriptor，不允许部分激活。
 */
export function setCampaignRoleProfile(
  raw: Database,
  input: SetRoleProfileInput,
  options: SetRoleProfileOptions = {},
): CampaignRuntimeView {
  const campaign = raw
    .prepare(`SELECT id, role_profile_id FROM campaign WHERE id = ?`)
    .get(input.campaignId) as { id: string; role_profile_id: string | null } | undefined;
  if (!campaign) throw new Error(`Campaign 不存在：${input.campaignId}`);

  const resolved = resolver.resolve({
    coreVersion: CORE_VERSION,
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    rolePackId: input.rolePackId,
    industryVariantId: input.industryVariantId ?? undefined,
    capabilityIds: input.capabilityIds ?? [],
  });
  if (!resolved.ok) {
    throw new Error(`${resolved.error.code}: ${resolved.error.message}`);
  }

  const snapshot = resolved.descriptor;
  const timestamp = options.now?.() ?? Date.now();
  const roleProfileId = campaign.role_profile_id ?? randomUUID();

  const activate = raw.transaction(() => {
    if (campaign.role_profile_id) {
      raw
        .prepare(
          `UPDATE role_profile
           SET role_family = ?, role_pack_id = ?, level = ?, industry_variant_id = ?,
               location = ?, interview_language = ?, confidence = ?, user_confirmed = ?
           WHERE id = ?`,
        )
        .run(
          input.roleFamily,
          input.rolePackId,
          input.level ?? null,
          snapshot.industryVariantId ?? null,
          input.location ?? null,
          input.interviewLanguage ?? 'zh',
          input.confidence ?? 1,
          input.userConfirmed === false ? 0 : 1,
          roleProfileId,
        );
    } else {
      raw
        .prepare(
          `INSERT INTO role_profile (
             id, role_family, role_pack_id, level, industry_variant_id, location,
             interview_language, confidence, user_confirmed
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          roleProfileId,
          input.roleFamily,
          input.rolePackId,
          input.level ?? null,
          snapshot.industryVariantId ?? null,
          input.location ?? null,
          input.interviewLanguage ?? 'zh',
          input.confidence ?? 1,
          input.userConfirmed === false ? 0 : 1,
        );
      raw
        .prepare(`UPDATE campaign SET role_profile_id = ? WHERE id = ?`)
        .run(roleProfileId, input.campaignId);
    }

    const previous = raw
      .prepare(
        `SELECT max(revision) AS revision FROM campaign_plugin_binding WHERE campaign_id = ?`,
      )
      .get(input.campaignId) as { revision: number | null };
    const revision = (previous.revision ?? 0) + 1;

    // 旧 revision 只停用执行，不删除：历史结果必须继续可解释。
    raw
      .prepare(`UPDATE campaign_plugin_binding SET active_execution = 0 WHERE campaign_id = ?`)
      .run(input.campaignId);

    const insertBinding = raw.prepare(
      `INSERT INTO campaign_plugin_binding (
         id, campaign_id, plugin_id, plugin_version, config_json,
         config_snapshot_hash, revision, active_execution, enabled_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    );
    // 行业变体不绑 binding：它只是岗位包内的一个键，没有自己的版本要固定
    const bound: ResolvedPluginRef[] = [
      snapshot.rolePack,
      ...snapshot.capabilities.filter(
        (item): item is ResolvedPluginRef & { enabled: true } => item.enabled,
      ),
    ];
    bound.forEach((plugin) => {
      insertBinding.run(
        randomUUID(),
        input.campaignId,
        plugin.id,
        plugin.version,
        JSON.stringify({ source: 'role-profile' }),
        snapshot.configSnapshotHash,
        revision,
        timestamp,
      );
    });

    raw
      .prepare(
        `INSERT INTO campaign_runtime_descriptor (
           id, campaign_id, revision, core_version, role_pack, industry_variant_id,
           capabilities, competency_baseline_version, config_snapshot_hash, resolved_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.campaignId,
        revision,
        snapshot.coreVersion,
        JSON.stringify(snapshot.rolePack),
        snapshot.industryVariantId ?? null,
        JSON.stringify(snapshot.capabilities),
        snapshot.competencyBaselineVersion,
        snapshot.configSnapshotHash,
        timestamp,
      );
  });

  activate();

  const view = readDescriptor(raw, input.campaignId);
  if (!view) throw new Error(`Runtime descriptor 写入后不可读：${input.campaignId}`);
  return view;
}

/**
 * 纯视图计算：只读 descriptor 与调用方的本机安装清单，绝不回写绑定。
 */
export function getClientCapabilityView(
  raw: Database,
  request: ClientCapabilityViewRequest,
): ClientCapabilityView | null {
  const runtime = readDescriptor(raw, request.campaignId);
  if (!runtime) return null;
  return buildClientCapabilityView({
    descriptor: runtime.descriptor,
    platform: request.platform,
    // 调用方没给就用本机真实安装集合。原来兜底到内置清单，在外置插件出现之后就是错的：
    // 手机端问过来时该由它自己给出本机集合，桌面替它答等于把桌面装的包算到手机头上
    installed: request.installed ?? listInstalledPlugins(),
    artifacts: request.artifacts,
  });
}
