import {
  PluginContractError,
  assertValidCapabilityPlugin,
  assertValidPluginManifest,
  assertValidRolePack,
} from './contracts';
import type { CapabilityPlugin, PluginManifest, RolePack } from './types';

export interface RolePackRegistry {
  register(pack: RolePack): void;
  get(id: string, version?: string): RolePack | null;
  list(): RolePack[];
}

export interface RegisteredPlugin {
  manifest: PluginManifest;
  rolePack?: RolePack;
  capability?: CapabilityPlugin;
}

export class PluginRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginRegistrationError';
  }
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseVersion(version: string): ParsedVersion {
  const buildIndex = version.indexOf('+');
  const withoutBuild = buildIndex === -1 ? version : version.slice(0, buildIndex);
  const prereleaseIndex = withoutBuild.indexOf('-');
  const numeric = prereleaseIndex === -1 ? withoutBuild : withoutBuild.slice(0, prereleaseIndex);
  const prerelease = prereleaseIndex === -1 ? '' : withoutBuild.slice(prereleaseIndex + 1);
  const [major = '0', minor = '0', patch = '0'] = numeric.split('.');
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ? prerelease.split('.') : [],
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null;
    if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber;
    if (leftNumber !== null) return -1;
    if (rightNumber !== null) return 1;
    return compareStrings(leftPart, rightPart);
  }
  return 0;
}

export function compareExactSemVer(left: string, right: string): number {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  if (leftVersion.major !== rightVersion.major) return leftVersion.major - rightVersion.major;
  if (leftVersion.minor !== rightVersion.minor) return leftVersion.minor - rightVersion.minor;
  if (leftVersion.patch !== rightVersion.patch) return leftVersion.patch - rightVersion.patch;
  return comparePrerelease(leftVersion.prerelease, rightVersion.prerelease);
}

function cloneAndFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  const clone = (Array.isArray(value) ? [] : {}) as Record<string, unknown>;
  Object.entries(value).forEach(([key, item]) => {
    clone[key] = cloneAndFreeze(item);
  });
  return Object.freeze(clone) as T;
}

/**
 * 进程内的内置插件唯一事实源。相同 id/version 不允许覆盖，避免注册顺序改变结果。
 */
export class BuiltInPluginRegistry implements RolePackRegistry {
  private readonly plugins = new Map<string, Map<string, RegisteredPlugin>>();

  register(pack: RolePack): void {
    assertValidRolePack(pack);
    this.add({ manifest: pack.manifest, rolePack: pack });
  }

  registerCapability(plugin: CapabilityPlugin): void {
    assertValidCapabilityPlugin(plugin);
    this.add({ manifest: plugin.manifest, capability: plugin });
  }

  registerIndustryPack(manifest: PluginManifest): void {
    assertValidPluginManifest(manifest);
    if (manifest.type !== 'industry-pack') {
      throw new PluginContractError([
        {
          path: 'manifest.type',
          code: 'invalid-value',
          message: 'Industry Pack 的 manifest.type 必须是 industry-pack',
        },
      ]);
    }
    this.add({ manifest });
  }

  get(id: string, version?: string): RolePack | null {
    const entries = this.listEntries(id).filter(
      (entry): entry is RegisteredPlugin & { rolePack: RolePack } => entry.rolePack !== undefined,
    );
    if (version !== undefined) {
      return entries.find((entry) => entry.manifest.version === version)?.rolePack ?? null;
    }
    return entries.at(-1)?.rolePack ?? null;
  }

  list(): RolePack[] {
    return this.listAllEntries()
      .filter(
        (entry): entry is RegisteredPlugin & { rolePack: RolePack } => entry.rolePack !== undefined,
      )
      .map((entry) => entry.rolePack);
  }

  getEntry(id: string, version: string): RegisteredPlugin | null {
    return this.plugins.get(id)?.get(version) ?? null;
  }

  listEntries(id: string): RegisteredPlugin[] {
    return [...(this.plugins.get(id)?.values() ?? [])].sort((left, right) => {
      const precedence = compareExactSemVer(left.manifest.version, right.manifest.version);
      return (
        precedence ||
        compareStrings(left.manifest.version, right.manifest.version)
      );
    });
  }

  listAllEntries(): RegisteredPlugin[] {
    return [...this.plugins.keys()]
      .sort()
      .flatMap((id) => this.listEntries(id));
  }

  private add(plugin: RegisteredPlugin): void {
    const snapshot = cloneAndFreeze(plugin);
    const { id, version } = snapshot.manifest;
    let versions = this.plugins.get(id);
    if (!versions) {
      versions = new Map<string, RegisteredPlugin>();
      this.plugins.set(id, versions);
    }
    if (versions.has(version)) {
      throw new PluginRegistrationError(`插件已注册：${id}@${version}`);
    }
    versions.set(version, snapshot);
  }
}
