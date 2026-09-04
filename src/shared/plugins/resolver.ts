import { RUNTIME_AVAILABILITIES, type PluginType } from '../enums';
import {
  isExactSemVer,
  isStablePluginId,
  validateCapabilityPlugin,
  validatePluginManifest,
  validateRolePack,
} from './contracts';
import { compareExactSemVer, type BuiltInPluginRegistry, type RegisteredPlugin } from './registry';
import type {
  ArtifactParserDefinition,
  CampaignRuntimeDescriptor,
  CapabilityRegistry,
  HostRenderedInteraction,
  PluginManifest,
  ResolvedCapabilityRef,
  ResolvedPluginRef,
  ScopedToolDefinition,
} from './types';

export type RuntimeResolveErrorCode =
  | 'plugin-not-found'
  | 'version-conflict'
  | 'dependency-cycle'
  | 'core-incompatible'
  | 'schema-incompatible'
  | 'invalid-manifest';

export interface RuntimeResolveError {
  code: RuntimeResolveErrorCode;
  message: string;
  pluginId?: string;
  dependencyPath?: string[];
}

export interface ResolveRuntimeInput {
  coreVersion: string;
  schemaVersion: number;
  rolePackId: string;
  industryPackId?: string;
  capabilityIds: string[];
  pinnedVersions?: Record<string, string>;
}

/**
 * Resolver 只产生确定性配置快照。campaignId/resolvedAt 由 T03 在原子持久化时补齐，
 * 避免时间和设备信息进入跨端一致性 hash。
 */
export type ResolvedRuntimeSnapshot = Omit<
  CampaignRuntimeDescriptor,
  'campaignId' | 'resolvedAt'
>;

export type ResolveRuntimeResult =
  | { ok: true; descriptor: ResolvedRuntimeSnapshot }
  | { ok: false; error: RuntimeResolveError };

export interface RuntimeResolver {
  resolve(input: ResolveRuntimeInput): ResolveRuntimeResult;
}

interface VersionParts {
  major: number;
  minor: number;
  patch: number;
}

interface Requirement {
  id: string;
  range: string;
  source: string;
  expectedType: PluginType;
}

interface CandidateResult {
  candidates: RegisteredPlugin[];
  error?: RuntimeResolveError;
}

interface SolveSuccess {
  ok: true;
  selected: Map<string, RegisteredPlugin>;
}

interface SolveFailure {
  ok: false;
  error: RuntimeResolveError;
}

type SolveResult = SolveSuccess | SolveFailure;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parsePartialVersion(value: string): {
  parts: VersionParts;
  specified: number;
  wildcardAt: number | null;
} | null {
  const match = /^v?(\d+|x|X|\*)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?$/.exec(value);
  if (!match) return null;
  const raw = [match[1], match[2], match[3]];
  let specified = 0;
  let wildcardAt: number | null = null;
  const numbers = raw.map((part, index) => {
    if (part === undefined) return 0;
    if (/^(?:x|X|\*)$/.test(part)) {
      wildcardAt ??= index;
      return 0;
    }
    if (wildcardAt !== null) return Number.NaN;
    specified = index + 1;
    return Number(part);
  });
  if (numbers.some(Number.isNaN)) return null;
  return {
    parts: { major: numbers[0]!, minor: numbers[1]!, patch: numbers[2]! },
    specified,
    wildcardAt,
  };
}

function formatVersion(parts: VersionParts): string {
  return `${parts.major}.${parts.minor}.${parts.patch}`;
}

function compareTo(version: string, target: VersionParts): number {
  return compareExactSemVer(version, formatVersion(target));
}

function upperBoundForPartial(
  parts: VersionParts,
  specified: number,
  wildcardAt: number | null,
): VersionParts | null {
  const boundary = wildcardAt ?? (specified < 3 ? specified : null);
  if (boundary === null) return null;
  if (boundary === 0) return null;
  if (boundary === 1) return { major: parts.major + 1, minor: 0, patch: 0 };
  return { major: parts.major, minor: parts.minor + 1, patch: 0 };
}

function satisfiesComparator(version: string, comparator: string): boolean {
  const match = /^(<=|>=|<|>|=|~|\^)?(.+)$/.exec(comparator);
  if (!match) return false;
  const operator = match[1] ?? '';
  const rawVersion = match[2]!;
  if (isExactSemVer(rawVersion)) {
    const comparison = compareExactSemVer(version, rawVersion);
    const parts = parsePartialVersion(rawVersion.split('-', 1)[0]!)!.parts;
    if (operator === '^') {
      const upper =
        parts.major > 0
          ? { major: parts.major + 1, minor: 0, patch: 0 }
          : parts.minor > 0
            ? { major: 0, minor: parts.minor + 1, patch: 0 }
            : { major: 0, minor: 0, patch: parts.patch + 1 };
      return comparison >= 0 && compareTo(version, upper) < 0;
    }
    if (operator === '~') {
      const upper = { major: parts.major, minor: parts.minor + 1, patch: 0 };
      return comparison >= 0 && compareTo(version, upper) < 0;
    }
    if (operator === '<') return comparison < 0;
    if (operator === '<=') return comparison <= 0;
    if (operator === '>') return comparison > 0;
    if (operator === '>=') return comparison >= 0;
    return comparison === 0;
  }

  const partial = parsePartialVersion(rawVersion);
  if (!partial) return false;

  const { parts, specified, wildcardAt } = partial;
  if (operator === '^') {
    const caretPrecision = wildcardAt ?? specified;
    const upper =
      caretPrecision <= 1
        ? { major: parts.major + 1, minor: 0, patch: 0 }
        : parts.major > 0
        ? { major: parts.major + 1, minor: 0, patch: 0 }
        : caretPrecision <= 2 || parts.minor > 0
          ? { major: 0, minor: parts.minor + 1, patch: 0 }
          : { major: 0, minor: 0, patch: parts.patch + 1 };
    return compareTo(version, parts) >= 0 && compareTo(version, upper) < 0;
  }
  if (operator === '~') {
    const upper =
      specified <= 1
        ? { major: parts.major + 1, minor: 0, patch: 0 }
        : { major: parts.major, minor: parts.minor + 1, patch: 0 };
    return compareTo(version, parts) >= 0 && compareTo(version, upper) < 0;
  }

  const upper = upperBoundForPartial(parts, specified, wildcardAt);
  if (operator === '<') return compareTo(version, parts) < 0;
  if (operator === '<=') {
    return upper === null ? compareTo(version, parts) <= 0 : compareTo(version, upper) < 0;
  }
  if (operator === '>') {
    return upper === null ? compareTo(version, parts) > 0 : compareTo(version, upper) >= 0;
  }
  if (operator === '>=') return compareTo(version, parts) >= 0;

  return compareTo(version, parts) >= 0 && (upper === null || compareTo(version, upper) < 0);
}

export function satisfiesSemVerRange(version: string, range: string): boolean {
  if (!isExactSemVer(version)) return false;
  return range.split('||').some((alternative) => {
    const trimmed = alternative.trim();
    if (!trimmed) return false;
    const prereleaseCore = version.includes('-') ? version.split('-', 1)[0] : null;
    if (
      prereleaseCore &&
      !trimmed.includes(`${prereleaseCore}-`)
    ) {
      return false;
    }
    if (trimmed === '*') return true;
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(trimmed);
    if (hyphen) {
      const lowerText = hyphen[1]!;
      const upperText = hyphen[2]!;
      const lower = parsePartialVersion(lowerText);
      const upper = parsePartialVersion(upperText);
      const lowerSatisfied = isExactSemVer(lowerText)
        ? compareExactSemVer(version, lowerText) >= 0
        : lower !== null && compareTo(version, lower.parts) >= 0;
      if (!lowerSatisfied) return false;
      if (isExactSemVer(upperText)) return compareExactSemVer(version, upperText) <= 0;
      if (upper === null) return false;
      const upperExclusive = upperBoundForPartial(
        upper.parts,
        upper.specified,
        upper.wildcardAt,
      );
      return upperExclusive
        ? compareTo(version, upperExclusive) < 0
        : compareTo(version, upper.parts) <= 0;
    }
    const comparators = trimmed.split(/\s+/);
    return comparators.every((comparator) => satisfiesComparator(version, comparator));
  });
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => compareStrings(left, right));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    .join(',')}}`;
}

function utf8Bytes(value: string): number[] {
  const bytes: number[] = [];
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point <= 0x7f) bytes.push(point);
    else if (point <= 0x7ff) bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
    else if (point <= 0xffff) {
      bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    } else {
      bytes.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f),
      );
    }
  }
  return bytes;
}

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
  0x5be0cd19,
] as const;
const SHA256_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
  0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
  0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
  0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
  0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
] as const;

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

export function sha256(value: string): string {
  const bytes = utf8Bytes(value);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((high >>> shift) & 0xff);
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((low >>> shift) & 0xff);

  const hash: number[] = [...SHA256_INITIAL];
  const words = new Array<number>(64).fill(0);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const start = offset + index * 4;
      words[index] =
        ((bytes[start]! << 24) |
          (bytes[start + 1]! << 16) |
          (bytes[start + 2]! << 8) |
          bytes[start + 3]!) >>>
        0;
    }
    for (let index = 16; index < 64; index += 1) {
      const first =
        rotateRight(words[index - 15]!, 7) ^
        rotateRight(words[index - 15]!, 18) ^
        (words[index - 15]! >>> 3);
      const second =
        rotateRight(words[index - 2]!, 17) ^
        rotateRight(words[index - 2]!, 19) ^
        (words[index - 2]! >>> 10);
      words[index] = (words[index - 16]! + first + words[index - 7]! + second) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sigmaOne = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const tempOne = (h! + sigmaOne + choice + SHA256_CONSTANTS[index]! + words[index]!) >>> 0;
      const sigmaZero = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const tempTwo = (sigmaZero + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + tempOne) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (tempOne + tempTwo) >>> 0;
    }
    hash[0] = (hash[0]! + a!) >>> 0;
    hash[1] = (hash[1]! + b!) >>> 0;
    hash[2] = (hash[2]! + c!) >>> 0;
    hash[3] = (hash[3]! + d!) >>> 0;
    hash[4] = (hash[4]! + e!) >>> 0;
    hash[5] = (hash[5]! + f!) >>> 0;
    hash[6] = (hash[6]! + g!) >>> 0;
    hash[7] = (hash[7]! + h!) >>> 0;
  }
  return hash.map((part) => part.toString(16).padStart(8, '0')).join('');
}

export function hashRuntimeConfig(value: unknown): string {
  return sha256(canonicalize(value));
}

function addRequirement(
  requirements: Map<string, Requirement[]>,
  requirement: Requirement,
): void {
  const existing = requirements.get(requirement.id) ?? [];
  if (
    !existing.some(
      (item) =>
        item.range === requirement.range &&
        item.source === requirement.source &&
        item.expectedType === requirement.expectedType,
    )
  ) {
    existing.push(requirement);
    requirements.set(requirement.id, existing);
  }
}

function rootRequirements(input: ResolveRuntimeInput): Requirement[] {
  const requirements: Requirement[] = [
    {
      id: input.rolePackId,
      range: input.pinnedVersions?.[input.rolePackId] ?? '*',
      source: 'role-pack',
      expectedType: 'role-pack',
    },
  ];
  if (input.industryPackId) {
    requirements.push({
      id: input.industryPackId,
      range: input.pinnedVersions?.[input.industryPackId] ?? '*',
      source: 'industry-pack',
      expectedType: 'industry-pack',
    });
  }
  [...new Set(input.capabilityIds)].sort().forEach((id) => {
    requirements.push({
      id,
      range: input.pinnedVersions?.[id] ?? '*',
      source: 'selected-capability',
      expectedType: 'capability',
    });
  });
  return requirements;
}

function collectRequirements(
  roots: Requirement[],
  selected: Map<string, RegisteredPlugin>,
  pinnedVersions: Record<string, string>,
): Map<string, Requirement[]> {
  const requirements = new Map<string, Requirement[]>();
  roots.forEach((root) => addRequirement(requirements, root));
  const queue = [...new Set(roots.map((root) => root.id))].sort();
  const visited = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const entry = selected.get(id);
    if (!entry) continue;
    (entry.manifest.dependencies ?? [])
      .filter((dependency) => !dependency.optional)
      .forEach((dependency) => {
        addRequirement(requirements, {
          id: dependency.id,
          range: dependency.version,
          source: id,
          expectedType: 'capability',
        });
        queue.push(dependency.id);
        queue.sort();
      });
  }
  requirements.forEach((_, id) => {
    const pinned = pinnedVersions[id];
    if (pinned) {
      addRequirement(requirements, {
        id,
        range: pinned,
        source: 'pinned-version',
        expectedType: requirements.get(id)![0]!.expectedType,
      });
    }
  });
  return requirements;
}

function entryContractIssues(entry: RegisteredPlugin) {
  if (entry.rolePack) return validateRolePack(entry.rolePack);
  if (entry.capability) return validateCapabilityPlugin(entry.capability);
  return validatePluginManifest(entry.manifest);
}

function resolveCandidates(
  registry: BuiltInPluginRegistry,
  input: ResolveRuntimeInput,
  id: string,
  requirements: Requirement[],
): CandidateResult {
  const all = registry.listEntries(id);
  if (all.length === 0) {
    return {
      candidates: [],
      error: { code: 'plugin-not-found', pluginId: id, message: `插件未安装：${id}` },
    };
  }
  const inRange = all.filter((entry) =>
    requirements.every((requirement) =>
      requirement.source === 'pinned-version'
        ? entry.manifest.version === requirement.range
        : satisfiesSemVerRange(entry.manifest.version, requirement.range),
    ),
  );
  if (inRange.length === 0) {
    return {
      candidates: [],
      error: {
        code: 'version-conflict',
        pluginId: id,
        message: `没有同时满足所有版本范围的插件：${id}`,
      },
    };
  }
  const expectedTypes = new Set(requirements.map((requirement) => requirement.expectedType));
  const matchingType = inRange.filter((entry) => expectedTypes.has(entry.manifest.type));
  if (expectedTypes.size !== 1 || matchingType.length === 0) {
    return {
      candidates: [],
      error: { code: 'invalid-manifest', pluginId: id, message: `插件类型与引用位置不匹配：${id}` },
    };
  }
  for (const entry of matchingType) {
    if (entryContractIssues(entry).length > 0) {
      return {
        candidates: [],
        error: { code: 'invalid-manifest', pluginId: id, message: `插件契约校验失败：${id}` },
      };
    }
  }
  const coreCompatible = matchingType.filter((entry) =>
    satisfiesSemVerRange(input.coreVersion, entry.manifest.compatibility.core),
  );
  if (coreCompatible.length === 0) {
    return {
      candidates: [],
      error: { code: 'core-incompatible', pluginId: id, message: `插件与 Core 版本不兼容：${id}` },
    };
  }
  const schemaCompatible = coreCompatible.filter(
    (entry) => input.schemaVersion >= entry.manifest.compatibility.schema,
  );
  if (schemaCompatible.length === 0) {
    return {
      candidates: [],
      error: {
        code: 'schema-incompatible',
        pluginId: id,
        message: `插件需要更高的 schema 版本：${id}`,
      },
    };
  }
  return {
    candidates: schemaCompatible.sort((left, right) => {
      const precedence = compareExactSemVer(right.manifest.version, left.manifest.version);
      return (
        precedence ||
        compareStrings(right.manifest.version, left.manifest.version)
      );
    }),
  };
}

function selectedSatisfies(entry: RegisteredPlugin, requirements: Requirement[]): boolean {
  return (
    requirements.every(
      (requirement) =>
        requirement.expectedType === entry.manifest.type &&
        (requirement.source === 'pinned-version'
          ? entry.manifest.version === requirement.range
          : satisfiesSemVerRange(entry.manifest.version, requirement.range)),
    )
  );
}

function dependencyCycle(
  selected: Map<string, RegisteredPlugin>,
  includeOptional: boolean,
): string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  const visit = (id: string): string[] | null => {
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      return [...path.slice(start), id];
    }
    if (visited.has(id)) return null;
    const entry = selected.get(id);
    if (!entry) return null;
    visiting.add(id);
    path.push(id);
    for (const dependency of entry.manifest.dependencies ?? []) {
      if (dependency.optional && !includeOptional) continue;
      const target = selected.get(dependency.id);
      if (!target || !satisfiesSemVerRange(target.manifest.version, dependency.version)) continue;
      const cycle = visit(dependency.id);
      if (cycle) return cycle;
    }
    path.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };

  for (const id of [...selected.keys()].sort()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

class RegistrationCollector implements CapabilityRegistry {
  private readonly tools = new Map<string, string>();
  private readonly parsers = new Map<string, string>();
  private readonly interactions = new Map<string, string>();

  constructor(
    private readonly owner: string,
    private readonly permissions: ReadonlySet<string>,
    private readonly artifactSchemas: Readonly<Record<string, number>> = {},
    private readonly shared?: RegistrationCollector,
  ) {}

  forPlugin(owner: string, manifest: PluginManifest): RegistrationCollector {
    return new RegistrationCollector(
      owner,
      new Set(manifest.permissions),
      manifest.artifactSchemas ?? {},
      this,
    );
  }

  registerTool(tool: ScopedToolDefinition): void {
    this.assertPermission(tool.permission);
    this.registerUnique(this.root().tools, tool.name, '工具');
    if (!tool.name || !tool.description || !Number.isInteger(tool.inputSchemaVersion) || tool.inputSchemaVersion < 1) {
      throw new Error(`工具定义不合法：${tool.name}`);
    }
  }

  registerArtifactParser(parser: ArtifactParserDefinition): void {
    this.assertPermission(parser.permission);
    this.registerUnique(this.root().parsers, parser.artifactType, 'Artifact parser');
    if (!parser.artifactType || !Number.isInteger(parser.schemaVersion) || parser.schemaVersion < 1) {
      throw new Error(`Artifact parser 定义不合法：${parser.artifactType}`);
    }
    if (this.artifactSchemas[parser.artifactType] !== parser.schemaVersion) {
      throw new Error(`Artifact parser 未匹配 Manifest schema：${parser.artifactType}`);
    }
  }

  registerInteractionType(interaction: HostRenderedInteraction): void {
    this.registerUnique(this.root().interactions, interaction.type, '交互类型');
    if (!interaction.type || !Number.isInteger(interaction.schemaVersion) || interaction.schemaVersion < 1) {
      throw new Error(`交互类型定义不合法：${interaction.type}`);
    }
    if (
      !(['desktop', 'mobile'] as const).every((platform) =>
        (RUNTIME_AVAILABILITIES as readonly string[]).includes(
          interaction.availability[platform],
        ),
      )
    ) {
      throw new Error(`交互类型运行能力不合法：${interaction.type}`);
    }
  }

  private root(): RegistrationCollector {
    return this.shared?.root() ?? this;
  }

  private assertPermission(permission: string): void {
    if (!this.permissions.has(permission)) {
      throw new Error(`插件 ${this.owner} 未声明注册项所需权限：${permission}`);
    }
  }

  private registerUnique(target: Map<string, string>, id: string, label: string): void {
    const existing = target.get(id);
    if (existing) throw new Error(`${label}重复注册：${id}（${existing} / ${this.owner}）`);
    target.set(id, this.owner);
  }
}

function validateCapabilityRegistrations(
  selected: Map<string, RegisteredPlugin>,
): RuntimeResolveError | null {
  const collector = new RegistrationCollector('root', new Set(), {});
  for (const entry of [...selected.values()].sort((left, right) =>
    compareStrings(left.manifest.id, right.manifest.id),
  )) {
    if (!entry.capability) continue;
    try {
      entry.capability.register(collector.forPlugin(entry.manifest.id, entry.manifest));
    } catch (error) {
      return {
        code: 'invalid-manifest',
        pluginId: entry.manifest.id,
        message: error instanceof Error ? error.message : `插件注册失败：${entry.manifest.id}`,
      };
    }
  }
  return null;
}

function solveRequired(
  registry: BuiltInPluginRegistry,
  input: ResolveRuntimeInput,
  roots: Requirement[],
  initial = new Map<string, RegisteredPlugin>(),
  includeOptionalCycles = false,
  depth = 0,
): SolveResult {
  if (depth > registry.listAllEntries().length + roots.length + 1) {
    return {
      ok: false,
      error: { code: 'version-conflict', message: '依赖版本求解未收敛' },
    };
  }
  const requirements = collectRequirements(roots, initial, input.pinnedVersions ?? {});
  const unresolvedId = [...requirements.keys()]
    .sort()
    .find((id) => {
      const entry = initial.get(id);
      return !entry || !selectedSatisfies(entry, requirements.get(id)!);
    });

  if (!unresolvedId) {
    const reachable = new Map(
      [...requirements.keys()].sort().map((id) => [id, initial.get(id)!] as const),
    );
    const cycle = dependencyCycle(reachable, includeOptionalCycles);
    if (cycle) {
      return {
        ok: false,
        error: {
          code: 'dependency-cycle',
          pluginId: cycle[0],
          dependencyPath: cycle,
          message: `插件依赖成环：${cycle.join(' -> ')}`,
        },
      };
    }
    const registrationError = validateCapabilityRegistrations(reachable);
    if (registrationError) return { ok: false, error: registrationError };
    return { ok: true, selected: reachable };
  }

  const result = resolveCandidates(registry, input, unresolvedId, requirements.get(unresolvedId)!);
  if (result.candidates.length === 0) return { ok: false, error: result.error! };

  let firstError: RuntimeResolveError | undefined;
  for (const candidate of result.candidates) {
    const next = new Map(initial);
    next.set(unresolvedId, candidate);
    const solved = solveRequired(
      registry,
      input,
      roots,
      next,
      includeOptionalCycles,
      depth + 1,
    );
    if (solved.ok) return solved;
    firstError ??= solved.error;
  }
  return {
    ok: false,
    error: firstError ?? {
      code: 'version-conflict',
      pluginId: unresolvedId,
      message: `无法解析插件版本：${unresolvedId}`,
    },
  };
}

function optionalRequirements(selected: Map<string, RegisteredPlugin>): Requirement[] {
  const requirements: Requirement[] = [];
  [...selected.values()]
    .sort((left, right) => compareStrings(left.manifest.id, right.manifest.id))
    .forEach((entry) => {
      (entry.manifest.dependencies ?? []).forEach((dependency) => {
        if (!dependency.optional) return;
        requirements.push({
          id: dependency.id,
          range: dependency.version,
          source: entry.manifest.id,
          expectedType: 'capability',
        });
      });
    });
  return requirements;
}

function exactRoots(selected: Map<string, RegisteredPlugin>): Requirement[] {
  return [...selected.values()].map((entry) => ({
    id: entry.manifest.id,
    range: entry.manifest.version,
    source: 'already-resolved',
    expectedType: entry.manifest.type,
  }));
}

function disabledRef(requirement: Requirement, error: RuntimeResolveError): ResolvedCapabilityRef {
  return {
    id: requirement.id,
    enabled: false,
    disabledReason: `${error.code}: ${error.message}`,
  };
}

function requirementKey(requirement: Requirement): string {
  return `${requirement.source}:${requirement.id}:${requirement.range}`;
}

interface DisabledOptional {
  requirement: Requirement;
  ref: ResolvedCapabilityRef;
}

export class DeterministicRuntimeResolver implements RuntimeResolver {
  constructor(private readonly registry: BuiltInPluginRegistry) {}

  resolve(input: ResolveRuntimeInput): ResolveRuntimeResult {
    const inputError = this.validateInput(input);
    if (inputError) return { ok: false, error: inputError };

    const roots = rootRequirements(input);
    const required = solveRequired(this.registry, input, roots);
    if (!required.ok) return { ok: false, error: required.error };

    const baseRegistrationError = validateCapabilityRegistrations(required.selected);
    if (baseRegistrationError) return { ok: false, error: baseRegistrationError };

    let selected = required.selected;
    const requiredRoots = exactRoots(required.selected);
    let acceptedOptionals: Requirement[] = [];
    const disabled = new Map<string, DisabledOptional>();
    const handled = new Set<string>();
    while (true) {
      const nextOptional = optionalRequirements(selected).find(
        (requirement) => !handled.has(requirementKey(requirement)),
      );
      if (!nextOptional) break;
      const optionalKey = requirementKey(nextOptional);
      handled.add(optionalKey);

      const requiredEntry = required.selected.get(nextOptional.id);
      if (
        requiredEntry &&
        requiredEntry.manifest.type === 'capability' &&
        satisfiesSemVerRange(requiredEntry.manifest.version, nextOptional.range)
      ) {
        continue;
      }
      if (requiredEntry) {
        disabled.set(
          optionalKey,
          {
            requirement: nextOptional,
            ref: disabledRef(nextOptional, {
              code: 'version-conflict',
              pluginId: nextOptional.id,
              message: `已启用版本不满足可选依赖：${nextOptional.id}`,
            }),
          },
        );
        continue;
      }

      const proposedOptionals = [...acceptedOptionals, nextOptional];
      const attempt = solveRequired(
        this.registry,
        input,
        [...requiredRoots, ...proposedOptionals],
        selected,
        true,
      );
      if (!attempt.ok) {
        if (acceptedOptionals.some((requirement) => requirement.id === nextOptional.id)) {
          acceptedOptionals = acceptedOptionals.filter(
            (requirement) => requirement.id !== nextOptional.id,
          );
          const fallback = solveRequired(
            this.registry,
            input,
            [...requiredRoots, ...acceptedOptionals],
            required.selected,
            true,
          );
          if (fallback.ok) {
            selected = fallback.selected;
            while (true) {
              const reachableOptionals = acceptedOptionals.filter((requirement) =>
                selected.has(requirement.source),
              );
              if (reachableOptionals.length === acceptedOptionals.length) break;
              acceptedOptionals = reachableOptionals;
              const pruned = solveRequired(
                this.registry,
                input,
                [...requiredRoots, ...acceptedOptionals],
                required.selected,
                true,
              );
              if (!pruned.ok) break;
              selected = pruned.selected;
            }
          }
        }
        disabled.set(optionalKey, {
          requirement: nextOptional,
          ref: disabledRef(nextOptional, attempt.error),
        });
        continue;
      }
      const cycle = dependencyCycle(attempt.selected, true);
      if (cycle) {
        disabled.set(
          optionalKey,
          {
            requirement: nextOptional,
            ref: disabledRef(nextOptional, {
              code: 'dependency-cycle',
              pluginId: nextOptional.id,
              dependencyPath: cycle,
              message: `可选依赖会形成环：${cycle.join(' -> ')}`,
            }),
          },
        );
        continue;
      }
      const registrationError = validateCapabilityRegistrations(attempt.selected);
      if (registrationError) {
        disabled.set(optionalKey, {
          requirement: nextOptional,
          ref: disabledRef(nextOptional, registrationError),
        });
        continue;
      }
      selected = attempt.selected;
      acceptedOptionals = proposedOptionals;
      disabled.delete(optionalKey);
    }

    const role = selected.get(input.rolePackId)!;
    const industry = input.industryPackId ? selected.get(input.industryPackId)! : undefined;
    const enabledCapabilities: ResolvedCapabilityRef[] = [...selected.values()]
      .filter((entry) => entry.manifest.type === 'capability')
      .map((entry) => ({
        id: entry.manifest.id,
        version: entry.manifest.version,
        enabled: true as const,
      }));
    const disabledCapabilities = [
      ...new Map(
        [...disabled.values()]
          .filter(
            (item) =>
              selected.has(item.requirement.source) &&
              !selected.has(item.ref.id),
          )
          .sort((left, right) =>
            compareStrings(requirementKey(left.requirement), requirementKey(right.requirement)),
          )
          .map((item) => [item.ref.id, item.ref] as const),
      ).values(),
    ];
    const capabilities = [...enabledCapabilities, ...disabledCapabilities].sort((left, right) =>
      compareStrings(left.id, right.id),
    );
    const rolePack: ResolvedPluginRef = {
      id: role.manifest.id,
      version: role.manifest.version,
    };
    const industryPack: ResolvedPluginRef | undefined = industry
      ? { id: industry.manifest.id, version: industry.manifest.version }
      : undefined;
    const config = {
      coreVersion: input.coreVersion,
      schemaVersion: input.schemaVersion,
      rolePack,
      industryPack,
      capabilities,
      competencyBaselineVersion: role.manifest.version,
    };
    return {
      ok: true,
      descriptor: {
        coreVersion: input.coreVersion,
        rolePack,
        industryPack,
        capabilities,
        competencyBaselineVersion: role.manifest.version,
        configSnapshotHash: hashRuntimeConfig(config),
      },
    };
  }

  private validateInput(input: ResolveRuntimeInput): RuntimeResolveError | null {
    if (!isExactSemVer(input.coreVersion)) {
      return { code: 'invalid-manifest', message: 'coreVersion 必须是精确 SemVer' };
    }
    if (!Number.isInteger(input.schemaVersion) || input.schemaVersion < 0) {
      return { code: 'invalid-manifest', message: 'schemaVersion 必须是非负整数' };
    }
    const ids = [input.rolePackId, input.industryPackId, ...input.capabilityIds].filter(
      (id): id is string => id !== undefined,
    );
    if (ids.some((id) => !isStablePluginId(id))) {
      return { code: 'invalid-manifest', message: '请求包含非法插件 ID' };
    }
    for (const [id, version] of Object.entries(input.pinnedVersions ?? {})) {
      if (!isStablePluginId(id) || !isExactSemVer(version)) {
        return { code: 'invalid-manifest', pluginId: id, message: '固定版本必须使用合法 ID 和精确 SemVer' };
      }
    }
    return null;
  }
}
