/**
 * 交互会话的生命周期词汇。
 *
 * 放在协议层而不是主进程：这套状态要出现在 IPC 契约和两端界面上，
 * 只有主进程认识的话，界面就只能按字符串猜。
 *
 * 前两个是进行中状态，其余五个都是终态。四条异常路径（超时、取消、崩溃、
 * 权限撤销）各自有独立终态，界面据此给出不同说明，而不是笼统的「出错了」。
 */
export const INTERACTION_ACTIVE_STATUSES = ['awaiting-candidate', 'awaiting-customer'] as const;

export const INTERACTION_TERMINAL_STATUSES = [
  'completed',
  'timeout',
  'cancelled',
  'failed',
  'permission-revoked',
] as const;

export const INTERACTION_SESSION_STATUSES = [
  ...INTERACTION_ACTIVE_STATUSES,
  ...INTERACTION_TERMINAL_STATUSES,
] as const;

export type InteractionActiveStatus = (typeof INTERACTION_ACTIVE_STATUSES)[number];
export type InteractionTerminalStatus = (typeof INTERACTION_TERMINAL_STATUSES)[number];
export type InteractionSessionStatus = (typeof INTERACTION_SESSION_STATUSES)[number];

export function isInteractionTerminalStatus(
  status: InteractionSessionStatus,
): status is InteractionTerminalStatus {
  return (INTERACTION_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** 面向用户的终态说明；界面不需要自己拼文案。 */
export const INTERACTION_TERMINAL_LABELS: Record<InteractionTerminalStatus, string> = {
  completed: '本轮对练已完成',
  timeout: '已到时限',
  cancelled: '已中止',
  failed: '模型未能继续，已保留记录',
  'permission-revoked': '权限已撤销，已保留记录',
};
