/**
 * 宿主渲染交互的运行时。
 *
 * 职责边界：
 * - 只管交互会话的生命周期与角色状态，不碰数据库、不碰 Practice Engine；
 *   状态由调用方持久化（snapshot 是一段 JSON），所以本模块可以整体纯函数化。
 * - 客户台词由调用方注入的生成器产生，运行时只负责把它的失败关在笼子里。
 *
 * 四种异常路径都必须收敛成「良性终态」而不是抛异常：会话结束、对话记录留存、
 * Campaign 不受影响。任何一次误点、超时或模型崩溃都不应该让整个 Campaign 卡死。
 */
import {
  validateInteractionResultValue,
  type InteractionResultValue,
} from '@core/plugins/interactions/schema';
import {
  isInteractionTerminalStatus,
  type InteractionSessionStatus,
} from '@core/plugins/interactions/session';
import type { PluginPermission } from '@core/plugins/permissions';
import {
  CUSTOMER_CONVERSATION_SCHEMA_VERSION,
  type CustomerConversationScenario,
} from '@core/plugins/interactions/session';
import type { HostRenderedInteraction } from '@core/plugins/types';

/** 生成客户台词所需权限；被撤销后无法继续对练。 */
const LLM_PERMISSION: PluginPermission = 'llm:complete';
/** 语音作答所需权限；被撤销只降级为文字。 */
const MIC_PERMISSION: PluginPermission = 'microphone:read';

/** 客户台词连续失败的容忍次数，超过即以 failed 收尾。 */
export const PERSONA_FAILURE_BUDGET = 2;

export const ROLE_PLAY_STATE_VERSION = 1;

export type RolePlaySpeaker = 'customer' | 'candidate';

export interface RolePlayTurn {
  speaker: RolePlaySpeaker;
  text: string;
  /** 候选人自报的本轮意图；客户轮次为 null。 */
  intent: string | null;
  at: number;
}

/** 生命周期词汇由协议层拥有，两端与 IPC 契约共用同一套取值。 */
export type RolePlayStatus = InteractionSessionStatus;

export function isTerminalStatus(status: RolePlayStatus): boolean {
  return isInteractionTerminalStatus(status);
}

export interface RolePlayState {
  stateVersion: number;
  sessionId: string;
  interactionType: string;
  interactionSchemaVersion: number;
  scenarioId: string;
  status: RolePlayStatus;
  startedAt: number;
  deadlineAt: number;
  turns: RolePlayTurn[];
  /** 下一次该抛哪条异议；恢复后继续，不会从头再来。 */
  objectionCursor: number;
  /** 语音是否可用；权限撤销后转 false，会话继续。 */
  voiceEnabled: boolean;
  personaFailures: number;
  /** 终态说明；非终态为 null。 */
  terminalDetail: string | null;
}

export type RolePlayRejectionCode =
  | 'session-closed'
  | 'invalid-result'
  | 'not-awaiting-customer';

export type RolePlayTransition =
  | { ok: true; state: RolePlayState }
  | { ok: false; code: RolePlayRejectionCode; detail: string; state: RolePlayState };

function clone(state: RolePlayState): RolePlayState {
  return { ...state, turns: state.turns.map((turn) => ({ ...turn })) };
}

function terminate(
  state: RolePlayState,
  status: RolePlayStatus,
  detail: string,
): RolePlayState {
  const next = clone(state);
  next.status = status;
  next.terminalDetail = detail;
  if (status === 'permission-revoked' || status === 'failed') next.voiceEnabled = false;
  return next;
}

function reject(
  state: RolePlayState,
  code: RolePlayRejectionCode,
  detail: string,
): RolePlayTransition {
  return { ok: false, code, detail, state: clone(state) };
}

export interface StartRolePlayInput {
  sessionId: string;
  interaction: HostRenderedInteraction;
  scenario: CustomerConversationScenario;
  now: number;
  totalSeconds: number;
  grantedPermissions: readonly PluginPermission[];
}

/**
 * 开始一次客户对话。
 *
 * 开场白取自场景声明，因此第一轮不依赖模型：即便模型完全不可用，
 * 候选人也能看到客户开口，会话不会一启动就死在等待里。
 */
export function startRolePlaySession(input: StartRolePlayInput): RolePlayState {
  return {
    stateVersion: ROLE_PLAY_STATE_VERSION,
    sessionId: input.sessionId,
    interactionType: input.interaction.type,
    interactionSchemaVersion: input.interaction.schemaVersion,
    scenarioId: input.scenario.id,
    status: 'awaiting-candidate',
    startedAt: input.now,
    deadlineAt: input.now + input.totalSeconds * 1000,
    turns: [
      { speaker: 'customer', text: input.scenario.opening, intent: null, at: input.now },
    ],
    objectionCursor: 0,
    voiceEnabled: input.grantedPermissions.includes(MIC_PERMISSION),
    personaFailures: 0,
    terminalDetail: null,
  };
}

/**
 * 到时限即收尾。
 *
 * 每个状态迁移入口都先过这一关，所以「超时」不依赖任何定时器：
 * 宿主睡过去、进程被挂起或者用户合上盖子，恢复后第一次操作就会正确收敛。
 */
export function checkRolePlayTimeout(state: RolePlayState, now: number): RolePlayState {
  if (isTerminalStatus(state.status)) return clone(state);
  if (now < state.deadlineAt) return clone(state);
  return terminate(state, 'timeout', '已到本轮对练时限，对话记录已保留');
}

export interface SubmitCandidateTurnInput {
  reply: string;
  /** 未标注意图时传 undefined；resultSchema 里该字段非必填。 */
  intent?: string;
  now: number;
  interaction: HostRenderedInteraction;
  grantedPermissions: readonly PluginPermission[];
}

/**
 * 候选人提交一轮作答。
 *
 * 作答内容按 resultSchema 校验，不合法就拒绝并保持状态不变——
 * 拒绝是普通返回值而不是异常，宿主据此提示即可。
 */
export function submitCandidateTurn(
  state: RolePlayState,
  input: SubmitCandidateTurnInput,
): RolePlayTransition {
  const timed = checkRolePlayTimeout(state, input.now);
  if (isTerminalStatus(timed.status)) {
    return reject(timed, 'session-closed', timed.terminalDetail ?? '会话已结束');
  }

  const permissionChecked = applyPermissionChange(timed, input.grantedPermissions);
  if (isTerminalStatus(permissionChecked.status)) {
    return reject(
      permissionChecked,
      'session-closed',
      permissionChecked.terminalDetail ?? '会话已结束',
    );
  }

  const value: InteractionResultValue = { reply: input.reply };
  if (input.intent !== undefined) value.intent = input.intent;

  const issues = validateInteractionResultValue(
    input.interaction.resultSchema,
    input.interaction.inputSchema,
    value,
  );
  if (issues.length > 0) {
    return reject(
      permissionChecked,
      'invalid-result',
      issues.map((issue) => issue.message).join('；'),
    );
  }

  const next = clone(permissionChecked);
  next.turns.push({
    speaker: 'candidate',
    text: input.reply,
    intent: input.intent ?? null,
    at: input.now,
  });
  next.status = 'awaiting-customer';
  return { ok: true, state: next };
}

/** 客户台词生成器；由宿主注入，运行时不关心它怎么实现。 */
export type PersonaTurnGenerator = (context: PersonaTurnContext) => Promise<string>;

export interface PersonaTurnContext {
  scenario: CustomerConversationScenario;
  turns: readonly RolePlayTurn[];
  /** 建议抛出的异议；生成器可以采纳也可以自行组织。 */
  suggestedObjection: string | null;
}

/**
 * 推进客户的一轮台词。
 *
 * 生成器可能抛异常、超时或返回空串——这里一律当作一次失败计数，
 * 用完预算才以 failed 收尾。本函数**不会**向外抛异常。
 */
export async function advanceCustomerTurn(
  state: RolePlayState,
  options: {
    scenario: CustomerConversationScenario;
    generate: PersonaTurnGenerator;
    now: number;
    grantedPermissions: readonly PluginPermission[];
  },
): Promise<RolePlayTransition> {
  const timed = checkRolePlayTimeout(state, options.now);
  if (isTerminalStatus(timed.status)) {
    return reject(timed, 'session-closed', timed.terminalDetail ?? '会话已结束');
  }

  const permissionChecked = applyPermissionChange(timed, options.grantedPermissions);
  if (isTerminalStatus(permissionChecked.status)) {
    return reject(
      permissionChecked,
      'session-closed',
      permissionChecked.terminalDetail ?? '会话已结束',
    );
  }

  if (permissionChecked.status !== 'awaiting-customer') {
    return reject(permissionChecked, 'not-awaiting-customer', '当前不在等待客户回应');
  }

  const suggestedObjection =
    options.scenario.objections[permissionChecked.objectionCursor] ?? null;

  let text: string;
  try {
    text = await options.generate({
      scenario: options.scenario,
      turns: permissionChecked.turns,
      suggestedObjection,
    });
  } catch {
    return { ok: true, state: recordPersonaFailure(permissionChecked, '客户台词生成失败') };
  }

  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: true, state: recordPersonaFailure(permissionChecked, '客户台词为空') };
  }

  const next = clone(permissionChecked);
  next.turns.push({ speaker: 'customer', text: text.trim(), intent: null, at: options.now });
  next.status = 'awaiting-candidate';
  next.personaFailures = 0;
  if (suggestedObjection !== null) next.objectionCursor += 1;
  return { ok: true, state: next };
}

function recordPersonaFailure(state: RolePlayState, detail: string): RolePlayState {
  const next = clone(state);
  next.personaFailures += 1;
  if (next.personaFailures > PERSONA_FAILURE_BUDGET) {
    return terminate(next, 'failed', `${detail}，已保留对话记录`);
  }
  // 未用完预算就退回等候选人，宿主可以提示重试而不丢进度。
  next.status = 'awaiting-candidate';
  return next;
}

/** 用户主动中止；已产生的对话记录照常保留。 */
export function cancelRolePlaySession(state: RolePlayState, now: number): RolePlayState {
  if (isTerminalStatus(state.status)) return clone(state);
  const timed = checkRolePlayTimeout(state, now);
  if (isTerminalStatus(timed.status)) return timed;
  return terminate(timed, 'cancelled', '已中止本轮对练，对话记录已保留');
}

/** 候选人主动结束并交卷。 */
export function completeRolePlaySession(state: RolePlayState, now: number): RolePlayState {
  if (isTerminalStatus(state.status)) return clone(state);
  const timed = checkRolePlayTimeout(state, now);
  if (isTerminalStatus(timed.status)) return timed;
  return terminate(timed, 'completed', '本轮对练已完成');
}

/**
 * 同步当前权限。
 *
 * 两种撤销要区别对待：
 * - 麦克风撤销只是失去语音，改成打字照样能练，会话必须继续；
 * - 模型权限撤销后客户无法再开口，只能收尾，但对话记录留存，Campaign 不受影响。
 */
export function applyPermissionChange(
  state: RolePlayState,
  grantedPermissions: readonly PluginPermission[],
): RolePlayState {
  if (isTerminalStatus(state.status)) return clone(state);

  if (!grantedPermissions.includes(LLM_PERMISSION)) {
    return terminate(state, 'permission-revoked', '模型权限已撤销，本轮对练结束，记录已保留');
  }

  const next = clone(state);
  next.voiceEnabled = grantedPermissions.includes(MIC_PERMISSION);
  return next;
}

export type RolePlayRestoreResult =
  | { ok: true; state: RolePlayState }
  | { ok: false; code: 'malformed' | 'unsupported-version'; detail: string };

/** 角色状态快照；宿主自行决定存哪，运行时不关心。 */
export function snapshotRolePlayState(state: RolePlayState): string {
  return JSON.stringify(state);
}

/**
 * 从快照恢复。
 *
 * 快照可能来自更新的版本或已损坏，一律返回失败而不是抛异常，
 * 宿主据此退回只读，Campaign 的其余部分照常可用。
 */
export function restoreRolePlayState(snapshot: string): RolePlayRestoreResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot);
  } catch {
    return { ok: false, code: 'malformed', detail: '角色状态快照不是合法 JSON' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, code: 'malformed', detail: '角色状态快照结构不合法' };
  }

  const candidate = parsed as Partial<RolePlayState>;
  if (candidate.stateVersion !== ROLE_PLAY_STATE_VERSION) {
    return {
      ok: false,
      code: 'unsupported-version',
      detail: `本机支持的角色状态版本为 ${ROLE_PLAY_STATE_VERSION}，快照为 ${String(candidate.stateVersion)}`,
    };
  }

  if (
    typeof candidate.sessionId !== 'string' ||
    typeof candidate.scenarioId !== 'string' ||
    typeof candidate.status !== 'string' ||
    !Array.isArray(candidate.turns) ||
    typeof candidate.startedAt !== 'number' ||
    typeof candidate.deadlineAt !== 'number'
  ) {
    return { ok: false, code: 'malformed', detail: '角色状态快照缺少必要字段' };
  }

  if (candidate.interactionSchemaVersion !== CUSTOMER_CONVERSATION_SCHEMA_VERSION) {
    return {
      ok: false,
      code: 'unsupported-version',
      detail: `本机不认识该交互的 schema 版本：${String(candidate.interactionSchemaVersion)}`,
    };
  }

  return { ok: true, state: candidate as RolePlayState };
}

/** 供宿主渲染 transcript 字段。 */
export function rolePlayTranscript(state: RolePlayState): RolePlayTurn[] {
  return state.turns.map((turn) => ({ ...turn }));
}

/** 剩余秒数，供 countdown 字段渲染；已终态为 0。 */
export function rolePlayRemainingSeconds(state: RolePlayState, now: number): number {
  if (isTerminalStatus(state.status)) return 0;
  return Math.max(0, Math.ceil((state.deadlineAt - now) / 1000));
}
