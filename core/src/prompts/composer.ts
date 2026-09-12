/**
 * Core Prompt 组合器：把 Core Policy、阶段、岗位包片段、证据和用户要求按固定
 * 顺序拼成一条 system prompt，并记录这次生成用到的插件版本。
 *
 * 插件化最容易退化成「字符串任意拼接」：岗位包直接给一整段 system prompt，
 * 基础约束被顶掉，出问题以后也说不清当时到底用了哪个版本的片段。所以这里
 * 定三件事，其余都可以由插件决定：
 *
 * 1. 层次顺序固定（PROMPT_LAYER_ORDER），Core Policy 永远第一节；
 * 2. 岗位包只能向预定义 Slot 贡献片段——正文来自包内 prompts/ markdown 文件
 *    （file 指向包内路径，text 由加载器内联），迁移期可用 ref 显式引用 registry
 *    的 promptId。file 与 ref 在类型与校验上都互斥，不再做「像不像 promptId」
 *    的字符串猜测：ref 引用了未注册的 promptId 直接报错；
 * 3. 会产出候选人个人事实的 slot 缺少已确认证据时直接拒绝组合（fail closed），
 *    不靠下游的事实校验兜。
 *
 * 组合结果连同 provenance 一起交给 Model Gateway（src/main/llm/json.ts），
 * 落进 prompt run 记录，这样某次评分或计划为什么变了才复现得出来。
 */

import type {
  CampaignRuntimeDescriptor,
  InterviewFormatDefinition,
  PromptFragment,
  ResolvedCapabilityRef,
  ResolvedPluginRef,
  RolePack,
  RubricDefinition,
} from '../plugins/types';
import {
  CORE_PROMPT_POLICY,
  EVIDENCE_GROUNDING_RULE,
  QUESTION_GROUNDING_RULE,
  RESUME_GROUNDING_RULE,
  SCORE_GROUNDING_RULE,
} from './grounding';
import {
  isRegisteredPrompt,
  resolvePrompt,
  type PromptExperiment,
  type PromptSlot,
} from './registry';

/**
 * 组合层次。顺序即优先级：越靠前越不可被后面的内容改写。
 * 与架构文档 §9 的 Prompt 层次一一对应，不允许调换或插入新层。
 */
export const PROMPT_LAYER_ORDER = [
  'corePolicy',
  'stagePolicy',
  'rolePackFragment',
  'industryFragment',
  'formatProtocol',
  'rubric',
  'candidateEvidence',
  'jobContext',
  'userRequest',
] as const;

export type PromptLayer = (typeof PROMPT_LAYER_ORDER)[number];

export type PromptStage =
  | 'diagnose'
  | 'study'
  | 'practice'
  | 'evaluate'
  | 'coach'
  | 'debrief';

/** Slot 决定阶段：调用方不用再单独传一次，也就不会传得和 slot 不一致 */
export const PROMPT_STAGE_BY_SLOT: Record<PromptSlot, PromptStage> = {
  diagnosis: 'diagnose',
  explanation: 'study',
  questionGeneration: 'practice',
  scoring: 'evaluate',
  answerCoaching: 'coach',
  debrief: 'debrief',
};

/**
 * 阶段说明刻意只描述「现在在做哪一步」，不追加新规则：
 * 组合器要保证工程岗位现有 prompt 的语义不变，多一条硬约束就可能改变行为。
 */
const STAGE_POLICY: Record<PromptStage, string> = {
  diagnose: '当前阶段：诊断。把岗位能力要求与候选人已有证据交叉比对。',
  study: '当前阶段：讲解。帮助候选人真正理解这个考点。',
  practice: '当前阶段：训练。出题并模拟真实追问压力。',
  evaluate: '当前阶段：评分。按量规给分并给出可执行的改进动作。',
  coach: '当前阶段：话术辅导。产出候选人可以直接口述的内容。',
  debrief: '当前阶段：面后复盘。整理真实问题并修正能力图谱。',
};

/** 按 slot 取事实来源规则；诊断和讲解不产出候选人自述内容，不需要 */
const SLOT_GROUNDING_RULE: Partial<Record<PromptSlot, string>> = {
  questionGeneration: QUESTION_GROUNDING_RULE,
  scoring: SCORE_GROUNDING_RULE,
  answerCoaching: RESUME_GROUNDING_RULE,
  debrief: RESUME_GROUNDING_RULE,
};

/**
 * 以候选人口吻产出个人事实的 slot。这些 slot 没有已确认证据时不允许组合：
 * 让模型先编出来、再指望下游删干净，删不掉的那部分就成了用户背去考场的假经历。
 */
const PERSONAL_FACT_SLOTS: ReadonlySet<PromptSlot> = new Set<PromptSlot>([
  'answerCoaching',
  'debrief',
]);

/** 一级标题属于 Core 骨架（# 角色 / # 任务 / # 输出格式），插件片段只能用 ## 起 */
const CORE_HEADING_RE = /^#\s+\S/m;

const FRAGMENT_LENGTH_LIMIT = 4000;

/** djb2：片段正文的内容指纹，进 provenance 让「哪个版本的片段」可回溯 */
function shortHash(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 静态检查不是唯一安全边界，但这几类写法一旦放行，后面的层次约束就全是空话 */
const FRAGMENT_FORBIDDEN_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /忽略(以上|上述|之前|前面|所有)[^\n]{0,12}(规则|指令|要求|约束|提示)/, reason: '角色重置' },
  { pattern: /ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|above|prior|preceding)/i, reason: '角色重置' },
  { pattern: /(?:system\s*prompt|系统提示词|系统提示语)/i, reason: '试图改写 System Prompt' },
  { pattern: /你(?:现在)?(?:不再|无需再)(?:是|受|遵守)/, reason: '角色重置' },
  { pattern: /(?:无需|不需要|不用|可以不)[^\n]{0,8}(?:遵守|考虑|校验)?[^\n]{0,8}(?:证据|简历|事实来源)/, reason: '绕过证据策略' },
  { pattern: /(?:可以|允许|请)(?:虚构|编造|杜撰|假设候选人做过)/, reason: '绕过证据策略' },
  { pattern: /(?:提升|获取|绕过|无视)[^\n]{0,8}(?:权限|密钥|凭据|token)/i, reason: '权限提升' },
  { pattern: /(?:read|write|access)\s+(?:any|arbitrary|all)\s+(?:file|files|path)/i, reason: '权限提升' },
];

export interface PromptEvidence {
  id: string;
  kind: string;
  statement: string;
  /** 未确认的 proposal 不算证据：Core 去重和用户确认之后才是可信事实 */
  userConfirmed: boolean;
}

/** 行业包只能追加片段，位置固定在岗位包之后 */
export interface PromptIndustryFragment {
  pluginId: string;
  pluginVersion: string;
  text: string;
}

/**
 * 组合只依赖 descriptor 里与 provenance 相关的字段，不要求调用方先落库，
 * T02 的 ResolvedRuntimeSnapshot 也能直接传进来。
 */
export type PromptRuntimeSnapshot = Pick<
  CampaignRuntimeDescriptor,
  'coreVersion' | 'rolePack' | 'industryPack' | 'capabilities' | 'configSnapshotHash'
>;

export interface PromptCompositionInput {
  runtime: PromptRuntimeSnapshot;
  /** 必须与 runtime.rolePack 指向同一个精确版本 */
  rolePack: RolePack;
  slot: PromptSlot;
  /** questionGeneration / scoring / answerCoaching 按题型分片，必填 */
  formatId?: string;
  industryFragment?: PromptIndustryFragment;
  /** 已确认的候选人证据。未确认项会被丢弃，不参与组合 */
  evidence?: PromptEvidence[];
  /** 只能把门槛抬高：传 false 不会让 PERSONAL_FACT_SLOTS 放行 */
  requiresPersonalFacts?: boolean;
  /** 岗位 / 公司 / JD 动态上下文（目标要求，不是候选人经历） */
  jobContext?: string;
  /** 用户本次明确要求，优先级最低 */
  userRequest?: string;
  /** 透传给 build 型 prompt（explain 的 tier、design 的 type 等） */
  params?: Record<string, string | undefined>;
  experiment?: PromptExperiment;
  fingerprint?: string;
}

/**
 * 一次生成的可追溯记录。少任何一项都会出现「这次结果解释不了」的情况：
 * 插件升级后回头看历史评分，只有精确版本能说明当时用的是哪套规则。
 */
export interface PromptProvenance {
  coreVersion: string;
  rolePack: ResolvedPluginRef;
  industryPack?: ResolvedPluginRef;
  /** 本次运行时已启用的能力插件 ID，字典序 */
  capabilityIds: string[];
  /** 同一批能力的精确版本 */
  capabilities: ResolvedPluginRef[];
  promptSlot: PromptSlot;
  formatId?: string;
  /** registry key，或插件自带片段的稳定标识 */
  promptId: string;
  promptVersionId: string;
  rubricId?: string;
  evidenceIds: string[];
  configSnapshotHash: string;
}

export interface ComposedPromptSection {
  layer: PromptLayer;
  text: string;
}

export interface ComposedPrompt {
  systemPrompt: string;
  sections: ComposedPromptSection[];
  provenance: PromptProvenance;
}

export type PromptCompositionErrorCode =
  | 'runtime-mismatch'
  | 'missing-fragment'
  | 'unknown-format'
  | 'fragment-overrides-core'
  | 'missing-evidence';

export class PromptCompositionError extends Error {
  readonly code: PromptCompositionErrorCode;
  readonly detail?: string;

  constructor(code: PromptCompositionErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'PromptCompositionError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * 片段解析的唯一实现：同 slot 内 formatId 精确匹配优先于全题型兜底。
 * composer 内部抛错版与给宿主（如 Story 挑题型）用的只读版都走这里。
 */
export function resolveRolePackFragment(
  rolePack: RolePack,
  slot: PromptSlot,
  formatId?: string,
): PromptFragment | undefined {
  const candidates = rolePack.promptFragments.filter((fragment) => fragment.slot === slot);
  const exact = formatId
    ? candidates.find((fragment) => fragment.formatId === formatId)
    : undefined;
  return exact ?? candidates.find((fragment) => fragment.formatId === undefined);
}

function resolveFragment(input: PromptCompositionInput): PromptFragment {
  const { slot, formatId } = input;
  if (slot === 'questionGeneration' || slot === 'scoring' || slot === 'answerCoaching') {
    if (!formatId) {
      throw new PromptCompositionError(
        'unknown-format',
        `${slot} 按题型分片，必须指定 formatId`,
      );
    }
  }
  const fragment = resolveRolePackFragment(input.rolePack, slot, formatId);
  if (!fragment) {
    throw new PromptCompositionError(
      'missing-fragment',
      formatId
        ? `岗位包 ${input.rolePack.manifest.id} 未为 ${formatId} 提供 ${slot} 片段`
        : `岗位包 ${input.rolePack.manifest.id} 未提供 ${slot} 片段`,
    );
  }
  return fragment;
}

/**
 * 片段/指令文本的静态安全检查。导出给岗位包装配（pack-authoring）复用：
 * 简历模块的抽取指令与 Prompt 片段走同一套边界——一级标题、角色重置、
 * 权限提升和绕过证据策略的写法在这里就拦下，不等进 prompt 才炸。
 */
export function assertPluginFragmentSafe(
  text: string,
  origin: string,
  maxLength: number | null = FRAGMENT_LENGTH_LIMIT,
): void {
  if (text.trim().length === 0) {
    throw new PromptCompositionError('missing-fragment', `${origin} 的片段为空`);
  }
  // 文件化片段不设长度上限：上限只针对「运行时兜底文本」，防止片段被当成完整 System Prompt
  if (maxLength !== null && text.length > maxLength) {
    throw new PromptCompositionError(
      'fragment-overrides-core',
      `${origin} 的片段超过 ${maxLength} 字符，片段不能当成完整 System Prompt`,
    );
  }
  if (CORE_HEADING_RE.test(text)) {
    throw new PromptCompositionError(
      'fragment-overrides-core',
      `${origin} 的片段使用了一级标题：角色、任务和输出格式骨架由 Core 独占`,
    );
  }
  for (const { pattern, reason } of FRAGMENT_FORBIDDEN_PATTERNS) {
    if (pattern.test(text)) {
      throw new PromptCompositionError(
        'fragment-overrides-core',
        `${origin} 的片段试图${reason}`,
        reason,
      );
    }
  }
}

function resolveFormat(
  input: PromptCompositionInput,
): { format?: InterviewFormatDefinition; rubric?: RubricDefinition } {
  if (!input.formatId) return {};
  const format = input.rolePack.interviewFormats.find((item) => item.id === input.formatId);
  if (!format) {
    throw new PromptCompositionError(
      'unknown-format',
      `岗位包 ${input.rolePack.manifest.id} 没有面试形式 ${input.formatId}`,
    );
  }
  const rubric = input.rolePack.rubrics.find((item) => item.id === format.rubricId);
  return { format, rubric };
}

function formatProtocolSection(format: InterviewFormatDefinition): string {
  return [
    '## 面试形式（岗位包声明，不可自行更换）',
    `- 形式：${format.label}（${format.id}）`,
    `- 协议：${format.protocol}`,
    `- 建议时长：${format.defaultDurationMinutes} 分钟`,
    `- 追问：最多 ${format.followUpPolicy.maxRounds} 轮（${format.followUpPolicy.strategy}）`,
  ].join('\n');
}

function rubricSection(rubric: RubricDefinition): string {
  const lines = [`## 评分量规（${rubric.id}）`];
  for (const dimension of rubric.dimensions) {
    const weight = `${Math.round(dimension.weight * 100)}%`;
    const critical = dimension.critical ? '，关键维度' : '';
    lines.push(`### ${dimension.label}（${dimension.id}，权重 ${weight}${critical}）`);
    for (const score of [1, 2, 3, 4, 5] as const) {
      lines.push(`- ${score} 分：${dimension.anchors[score]}`);
    }
  }
  if (rubric.passThreshold !== undefined) lines.push(`- 通过阈值：${rubric.passThreshold}`);
  for (const condition of rubric.failConditions ?? []) {
    lines.push(`- 直接失败：${condition}`);
  }
  return lines.join('\n');
}

function evidenceSection(evidence: PromptEvidence[]): string {
  const lines = ['## 候选人证据（已确认，个人经历的唯一来源）'];
  for (const item of evidence) {
    lines.push(`- [evidence:${item.id}]（${item.kind}）${item.statement}`);
  }
  return [lines.join('\n'), EVIDENCE_GROUNDING_RULE].join('\n\n');
}

/**
 * 按固定顺序组合，并返回可追溯的 provenance。
 *
 * 抛错而不是返回 Result：拿不到合法组合时唯一正确的处理是停下来，把「组合失败」
 * 当成一种可以继续往下走的返回值，迟早会有调用点忽略它。
 */
export function composePrompt(input: PromptCompositionInput): ComposedPrompt {
  const { runtime, rolePack, slot } = input;
  if (
    rolePack.manifest.id !== runtime.rolePack.id ||
    rolePack.manifest.version !== runtime.rolePack.version
  ) {
    throw new PromptCompositionError(
      'runtime-mismatch',
      `岗位包与运行时绑定不一致：${rolePack.manifest.id}@${rolePack.manifest.version} ` +
        `vs ${runtime.rolePack.id}@${runtime.rolePack.version}`,
    );
  }

  const fragment = resolveFragment(input);
  let fragmentText: string;
  let promptId: string;
  let promptVersionId: string;
  if (fragment.ref !== undefined) {
    // ref 是显式契约：引用了不存在的 promptId 立刻停下，不再回退成「当成自带文本」
    if (!isRegisteredPrompt(fragment.ref)) {
      throw new PromptCompositionError(
        'missing-fragment',
        `岗位包 ${rolePack.manifest.id} 引用了未注册的 promptId：${fragment.ref}`,
      );
    }
    const resolved = resolvePrompt(fragment.ref, input.params, input.experiment, input.fingerprint);
    fragmentText = resolved.text;
    promptId = resolved.promptId;
    promptVersionId = resolved.versionId;
  } else if (fragment.text !== undefined) {
    const origin = fragment.file ?? `${rolePack.manifest.id} 的 ${slot}`;
    // 文件化片段不做长度截断：静态安全检查照跑，长度上限只属于运行时兜底文本
    assertPluginFragmentSafe(fragment.text, origin, null);
    fragmentText = fragment.text;
    promptId = `${rolePack.manifest.id}:${fragment.file ?? slot}`;
    promptVersionId = `${promptId}@${rolePack.manifest.version}#${shortHash(fragmentText)}`;
  } else {
    throw new PromptCompositionError(
      'missing-fragment',
      `岗位包 ${rolePack.manifest.id} 的 ${slot} 片段既没有 ref 也没有正文`,
    );
  }

  if (input.industryFragment) {
    assertPluginFragmentSafe(
      input.industryFragment.text,
      `行业包 ${input.industryFragment.pluginId}`,
    );
  }

  const confirmedEvidence = (input.evidence ?? []).filter((item) => item.userConfirmed);
  const needsPersonalFacts =
    PERSONAL_FACT_SLOTS.has(slot) || input.requiresPersonalFacts === true;
  if (needsPersonalFacts && confirmedEvidence.length === 0) {
    throw new PromptCompositionError(
      'missing-evidence',
      `${slot} 会产出候选人个人事实，但没有可用的已确认证据，本次不组合 Prompt`,
    );
  }

  const { format, rubric } = resolveFormat(input);

  const sections: ComposedPromptSection[] = [
    { layer: 'corePolicy', text: CORE_PROMPT_POLICY },
    {
      layer: 'stagePolicy',
      text: `## 阶段\n${STAGE_POLICY[PROMPT_STAGE_BY_SLOT[slot]]}`,
    },
    { layer: 'rolePackFragment', text: fragmentText },
  ];

  // 片段已经带了同一条规则时不再重复：工程岗位的现有 prompt 都自带，重复一遍
  // 只是烧 token，而且两份文字迟早会漂移
  const groundingRule = SLOT_GROUNDING_RULE[slot];
  if (groundingRule && !fragmentText.includes(groundingRule)) {
    sections.push({ layer: 'rolePackFragment', text: groundingRule });
  }

  if (input.industryFragment) {
    sections.push({ layer: 'industryFragment', text: input.industryFragment.text });
  }
  if (format) {
    sections.push({ layer: 'formatProtocol', text: formatProtocolSection(format) });
  }
  // 只有评分阶段需要逐档锚点；别的 slot 塞进来会改变现有 prompt 的行为
  if (rubric && slot === 'scoring') {
    sections.push({ layer: 'rubric', text: rubricSection(rubric) });
  }
  if (confirmedEvidence.length > 0) {
    sections.push({ layer: 'candidateEvidence', text: evidenceSection(confirmedEvidence) });
  }
  if (input.jobContext?.trim()) {
    sections.push({
      layer: 'jobContext',
      text: `## 岗位与公司上下文（目标要求，不是候选人经历）\n${input.jobContext.trim()}`,
    });
  }
  if (input.userRequest?.trim()) {
    sections.push({
      layer: 'userRequest',
      text: `## 用户本次要求（不得与 Core Policy 冲突）\n${input.userRequest.trim()}`,
    });
  }

  const capabilities = runtime.capabilities
    .filter(
      (capability): capability is Extract<ResolvedCapabilityRef, { enabled: true }> =>
        capability.enabled,
    )
    .map((capability) => ({ id: capability.id, version: capability.version }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  return {
    systemPrompt: sections.map((section) => section.text).join('\n\n'),
    sections,
    provenance: {
      coreVersion: runtime.coreVersion,
      rolePack: { id: runtime.rolePack.id, version: runtime.rolePack.version },
      ...(runtime.industryPack ? { industryPack: runtime.industryPack } : {}),
      capabilityIds: capabilities.map((capability) => capability.id),
      capabilities,
      promptSlot: slot,
      ...(input.formatId ? { formatId: input.formatId } : {}),
      promptId,
      promptVersionId,
      ...(format ? { rubricId: format.rubricId } : {}),
      evidenceIds: confirmedEvidence.map((item) => item.id),
      configSnapshotHash: runtime.configSnapshotHash,
    },
  };
}
