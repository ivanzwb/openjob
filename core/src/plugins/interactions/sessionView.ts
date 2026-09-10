/**
 * 客户对话会话的跨进程视图模型。
 *
 * 界面拿到的是「渲染指令 + 字段取值 + 一段快照」，不含任何可执行内容。
 * 快照随请求带回主进程，所以主进程无需保存会话状态。
 */
import type { InteractionHostView } from './hostView';
import type { InteractionSessionStatus } from './session';

export interface RolePlayTurnView {
  speaker: 'customer' | 'candidate';
  text: string;
  /** 候选人自报的本轮意图；客户轮次为 null。 */
  intent: string | null;
  at: number;
}

export interface RolePlayPersonaFactView {
  label: string;
  value: string;
}

/** 与 inputSchema 各字段 ID 对应的取值。 */
export interface RolePlayFieldValues {
  persona: RolePlayPersonaFactView[];
  scenario: string;
  transcript: RolePlayTurnView[];
  remainingSeconds: number;
}

export interface RolePlayRejectionView {
  code: string;
  detail: string;
}

export interface RolePlaySessionView {
  campaignId: string;
  scenarioId: string;
  scenarioTitle: string;
  /** 角色状态快照；下一次请求原样带回即可续练。 */
  snapshot: string;
  status: InteractionSessionStatus;
  terminal: boolean;
  /** 终态说明；非终态为 null。 */
  terminalDetail: string | null;
  view: InteractionHostView;
  values: RolePlayFieldValues;
  voiceEnabled: boolean;
  /** 本次请求被拒的原因；成功为 null。拒绝不是异常，界面照常渲染当前状态。 */
  rejection: RolePlayRejectionView | null;
}

export interface StartRolePlayRequest {
  campaignId: string;
  scenarioId?: string;
  /** 麦克风由操作系统把关，只有渲染进程看得见真实状态。 */
  microphoneAvailable: boolean;
}

export interface SubmitRolePlayTurnRequest {
  campaignId: string;
  snapshot: string;
  reply: string;
  intent?: string;
  microphoneAvailable: boolean;
}

export interface EndRolePlayRequest {
  campaignId: string;
  snapshot: string;
  action: 'cancel' | 'complete';
  microphoneAvailable: boolean;
}
