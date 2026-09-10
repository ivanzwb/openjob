/**
 * 客户对话会话服务。
 *
 * 刻意做成无状态：角色状态以快照（一段 JSON）随请求进出，主进程不留会话表也不留
 * 内存字典。于是「角色状态可恢复」不是额外实现的功能，而是结构自带的性质——
 * 主进程重启、渲染进程刷新都不影响，宿主把那段快照交回来就能接着练。
 *
 * 这里只做编排：解析岗位包与交互声明、组合提示词、调模型、拼出给界面用的视图模型。
 * 生命周期判定全部落在 interactionRuntime 里，本文件不重复实现任何一条终态规则。
 */
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';

import type { LlmRole } from '@core/enums';
import { composePrompt, type ComposedPrompt } from '@core/prompts/composer';
import {
  ROLE_PLAY_CAPABILITY_ID,
  ROLE_PLAY_SCENARIOS,
  customerConversationInteraction,
  rolePlayCapabilityPlugin,
  type RolePlayScenario,
} from '@core/plugins/builtin/rolePlay';
import { buildInteractionHostView } from '@core/plugins/interactions/hostView';
import type { PluginPermission } from '@core/plugins/permissions';
import type { InterviewFormatDefinition, RolePack } from '@core/plugins/types';
import type {
  EndRolePlayRequest,
  RolePlaySessionView,
  RolePlayTurnView,
  StartRolePlayRequest,
  SubmitRolePlayTurnRequest,
} from '@core/plugins/interactions/sessionView';
import { getRawDb } from '../db';
import { completeComposedJson } from '../llm/json';
import { resolveCampaignPracticeRuntime } from '../practice/rolePack';
import {
  advanceCustomerTurn,
  cancelRolePlaySession,
  completeRolePlaySession,
  isTerminalStatus,
  restoreRolePlayState,
  rolePlayRemainingSeconds,
  snapshotRolePlayState,
  startRolePlaySession,
  submitCandidateTurn,
  type RolePlayState,
} from './interactionRuntime';

/** 客户台词沿用 quiz 这一档模型配置，与练习出题同类。 */
const ROLE_PLAY_ROLE: LlmRole = 'quiz';

export class RolePlayError extends Error {
  constructor(
    readonly code:
      | 'capability-disabled'
      | 'format-unavailable'
      | 'scenario-unknown'
      | 'snapshot-unusable',
    message: string,
  ) {
    super(message);
    this.name = 'RolePlayError';
  }
}

export interface RolePlaySessionDeps {
  raw: Database;
  completeJson: <T>(request: {
    role: LlmRole;
    prompt: ComposedPrompt;
    user: string;
  }) => Promise<T>;
  now?: () => number;
  newId?: () => string;
}

export interface RolePlaySessionService {
  start(request: StartRolePlayRequest): Promise<RolePlaySessionView>;
  submitTurn(request: SubmitRolePlayTurnRequest): Promise<RolePlaySessionView>;
  end(request: EndRolePlayRequest): RolePlaySessionView;
}

function findScenario(scenarioId: string | undefined): RolePlayScenario {
  if (scenarioId === undefined) return ROLE_PLAY_SCENARIOS[0];
  const scenario = ROLE_PLAY_SCENARIOS.find((item) => item.id === scenarioId);
  if (!scenario) {
    throw new RolePlayError('scenario-unknown', `没有这个对练场景：${scenarioId}`);
  }
  return scenario;
}

/**
 * 找出本岗位包里由 role-play 支撑的题型。
 *
 * 不写死销售包：任何岗位包只要把某个题型的 capabilityId 指向 role-play，
 * 这里就能用。岗位包与能力插件之间靠 capabilityId 关联，不靠命名约定。
 */
function resolveRolePlayFormat(rolePack: RolePack): InterviewFormatDefinition {
  const format = rolePack.interviewFormats.find(
    (item) => item.capabilityId === ROLE_PLAY_CAPABILITY_ID,
  );
  if (!format) {
    throw new RolePlayError(
      'format-unavailable',
      `岗位包 ${rolePack.manifest.id} 没有依赖 role-play 的题型`,
    );
  }
  return format;
}

/**
 * 本机授予的权限。
 *
 * 插件声明的是「申请」，实际可用还要看设备：麦克风由操作系统把关，
 * 所以渲染进程观测到的状态才是真的。
 */
function grantedPermissions(microphoneAvailable: boolean): PluginPermission[] {
  return rolePlayCapabilityPlugin.manifest.permissions.filter(
    (permission) => permission !== 'microphone:read' || microphoneAvailable,
  );
}

function toTurnViews(state: RolePlayState): RolePlayTurnView[] {
  return state.turns.map((turn) => ({
    speaker: turn.speaker,
    text: turn.text,
    intent: turn.intent,
    at: turn.at,
  }));
}

export function createRolePlaySessionService(
  deps: RolePlaySessionDeps,
): RolePlaySessionService {
  const { raw } = deps;
  const now = (): number => deps.now?.() ?? Date.now();
  const newId = (): string => deps.newId?.() ?? randomUUID();

  /** 解析本次对练的岗位包、题型与本机渲染能力。 */
  function resolve(campaignId: string, microphoneAvailable: boolean) {
    const runtime = resolveCampaignPracticeRuntime(raw, campaignId);
    const format = resolveRolePlayFormat(runtime.rolePack);

    const capabilityRef = runtime.descriptor.capabilities.find(
      (item) => item.id === ROLE_PLAY_CAPABILITY_ID,
    );
    const capabilityEnabled = capabilityRef?.enabled === true;

    const permissions = grantedPermissions(microphoneAvailable);
    const view = buildInteractionHostView({
      interaction: customerConversationInteraction,
      platform: 'desktop',
      capabilityEnabled,
      pluginInstalled: true,
      knownSchemaVersion:
        rolePlayCapabilityPlugin.manifest.interactionSchemas?.[
          customerConversationInteraction.type
        ] ?? null,
      grantedPermissions: permissions,
    });

    return { runtime, format, view, permissions, capabilityEnabled };
  }

  function assemble(
    campaignId: string,
    scenario: RolePlayScenario,
    state: RolePlayState,
    resolved: ReturnType<typeof resolve>,
    rejection: RolePlaySessionView['rejection'],
  ): RolePlaySessionView {
    return {
      campaignId,
      scenarioId: scenario.id,
      scenarioTitle: scenario.title,
      snapshot: snapshotRolePlayState(state),
      status: state.status,
      terminal: isTerminalStatus(state.status),
      terminalDetail: state.terminalDetail,
      view: resolved.view,
      values: {
        persona: scenario.persona.map((fact) => ({ ...fact })),
        scenario: scenario.brief,
        transcript: toTurnViews(state),
        remainingSeconds: rolePlayRemainingSeconds(state, now()),
      },
      voiceEnabled: state.voiceEnabled,
      rejection,
    };
  }

  function load(snapshot: string): RolePlayState {
    const restored = restoreRolePlayState(snapshot);
    if (!restored.ok) {
      // 快照损坏或来自更新版本：明确报错让界面退回只读，不猜着往下跑
      throw new RolePlayError('snapshot-unusable', restored.detail);
    }
    return restored.state;
  }

  /** 组合客户台词的提示词；用岗位包自己的 role-play 片段，不引入任何工程侧正文。 */
  function customerPrompt(resolved: ReturnType<typeof resolve>): ComposedPrompt {
    return composePrompt({
      runtime: resolved.runtime.descriptor,
      rolePack: resolved.runtime.rolePack,
      slot: 'questionGeneration',
      formatId: resolved.format.id,
      params: { language: resolved.runtime.interviewLanguage },
    });
  }

  function customerRequest(
    scenario: RolePlayScenario,
    state: RolePlayState,
    suggestedObjection: string | null,
  ): string {
    const transcript = state.turns
      .map((turn) => `${turn.speaker === 'customer' ? '客户' : '候选人'}：${turn.text}`)
      .join('\n');
    const objection = suggestedObjection
      ? `\n\n如果时机合适，可以提出这个顾虑：${suggestedObjection}`
      : '';
    return [
      `你在扮演这位客户：${scenario.persona
        .map((fact) => `${fact.label}=${fact.value}`)
        .join('；')}`,
      `场景：${scenario.brief}`,
      `对话记录：\n${transcript}`,
      '请只输出客户接下来说的那一句话，保持这位客户的立场与情绪，不要评价候选人。',
    ].join('\n\n') + objection;
  }

  async function start(request: StartRolePlayRequest): Promise<RolePlaySessionView> {
    const resolved = resolve(request.campaignId, request.microphoneAvailable);
    if (!resolved.capabilityEnabled) {
      throw new RolePlayError(
        'capability-disabled',
        '本次备考没有启用客户对话模拟，请先在岗位与插件里启用',
      );
    }

    const scenario = findScenario(request.scenarioId);
    const state = startRolePlaySession({
      sessionId: newId(),
      interaction: customerConversationInteraction,
      scenario,
      now: now(),
      totalSeconds: resolved.format.defaultDurationMinutes * 60,
      grantedPermissions: resolved.permissions,
    });

    return assemble(request.campaignId, scenario, state, resolved, null);
  }

  /**
   * 提交一轮作答并推进客户回应。
   *
   * 两步合成一次往返，但失败语义分开：作答不合 schema 时原状退回；
   * 客户台词生成失败由运行时按预算处理，候选人刚打完的那段不会丢。
   */
  async function submitTurn(
    request: SubmitRolePlayTurnRequest,
  ): Promise<RolePlaySessionView> {
    const resolved = resolve(request.campaignId, request.microphoneAvailable);
    const restored = load(request.snapshot);
    const scenario = findScenario(restored.scenarioId);

    const submitted = submitCandidateTurn(restored, {
      reply: request.reply,
      intent: request.intent,
      now: now(),
      interaction: customerConversationInteraction,
      grantedPermissions: resolved.permissions,
    });

    if (!submitted.ok) {
      return assemble(request.campaignId, scenario, submitted.state, resolved, {
        code: submitted.code,
        detail: submitted.detail,
      });
    }

    const prompt = customerPrompt(resolved);
    const advanced = await advanceCustomerTurn(submitted.state, {
      scenario,
      now: now(),
      grantedPermissions: resolved.permissions,
      generate: async ({ suggestedObjection }) => {
        const generated = await deps.completeJson<{ reply?: string; questionMd?: string }>({
          role: ROLE_PLAY_ROLE,
          prompt,
          user: customerRequest(scenario, submitted.state, suggestedObjection),
        });
        // 两个键都接受：出题槽的既有约定是 questionMd
        return (generated.reply ?? generated.questionMd ?? '').trim();
      },
    });

    if (!advanced.ok) {
      return assemble(request.campaignId, scenario, advanced.state, resolved, {
        code: advanced.code,
        detail: advanced.detail,
      });
    }

    return assemble(request.campaignId, scenario, advanced.state, resolved, null);
  }

  function end(request: EndRolePlayRequest): RolePlaySessionView {
    const resolved = resolve(request.campaignId, request.microphoneAvailable);
    const restored = load(request.snapshot);
    const scenario = findScenario(restored.scenarioId);
    const state =
      request.action === 'cancel'
        ? cancelRolePlaySession(restored, now())
        : completeRolePlaySession(restored, now());

    return assemble(request.campaignId, scenario, state, resolved, null);
  }

  return { start, submitTurn, end };
}

let service: RolePlaySessionService | null = null;

/**
 * 进程内单例。
 *
 * 单例只为省掉重复构造，服务本身仍然无状态：会话状态在快照里，
 * 所以这个单例不持有任何一次对练的进度。
 */
export function getRolePlaySessionService(): RolePlaySessionService {
  if (!service) {
    service = createRolePlaySessionService({
      raw: getRawDb(),
      completeJson: completeComposedJson,
    });
  }
  return service;
}
