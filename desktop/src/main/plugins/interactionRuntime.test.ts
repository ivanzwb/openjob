import { describe, expect, it } from 'vitest';

import {
  ROLE_PLAY_SCENARIOS,
  customerConversationInteraction,
} from '@core/plugins/builtin/rolePlay';
import type { PluginPermission } from '@core/plugins/permissions';
import {
  PERSONA_FAILURE_BUDGET,
  ROLE_PLAY_STATE_VERSION,
  advanceCustomerTurn,
  applyPermissionChange,
  cancelRolePlaySession,
  checkRolePlayTimeout,
  completeRolePlaySession,
  isTerminalStatus,
  restoreRolePlayState,
  rolePlayRemainingSeconds,
  snapshotRolePlayState,
  startRolePlaySession,
  submitCandidateTurn,
  type RolePlayState,
} from './interactionRuntime';

const SCENARIO = ROLE_PLAY_SCENARIOS[0];
const T0 = 1_700_000_000_000;
const TOTAL_SECONDS = 600;
const ALL: PluginPermission[] = ['llm:complete', 'microphone:read'];

function start(grantedPermissions: readonly PluginPermission[] = ALL): RolePlayState {
  return startRolePlaySession({
    sessionId: 'session-1',
    interaction: customerConversationInteraction,
    scenario: SCENARIO,
    now: T0,
    totalSeconds: TOTAL_SECONDS,
    grantedPermissions,
  });
}

function submit(
  state: RolePlayState,
  reply: string,
  now: number,
  grantedPermissions: readonly PluginPermission[] = ALL,
): RolePlayState {
  const transition = submitCandidateTurn(state, {
    reply,
    intent: 'discover',
    now,
    interaction: customerConversationInteraction,
    grantedPermissions,
  });
  expect(transition.ok).toBe(true);
  return transition.state;
}

async function customerSays(
  state: RolePlayState,
  text: string,
  now: number,
  grantedPermissions: readonly PluginPermission[] = ALL,
): Promise<RolePlayState> {
  const transition = await advanceCustomerTurn(state, {
    scenario: SCENARIO,
    generate: async () => text,
    now,
    grantedPermissions,
  });
  expect(transition.ok).toBe(true);
  return transition.state;
}

describe('客户对话会话的正常推进', () => {
  it('开场白来自场景声明，第一轮不依赖模型', () => {
    const state = start();

    expect(state.status).toBe('awaiting-candidate');
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]).toMatchObject({ speaker: 'customer', text: SCENARIO.opening });
    expect(state.voiceEnabled).toBe(true);
  });

  it('一问一答交替推进，并按顺序抛出异议', async () => {
    let state = submit(start(), '我先了解一下上季度那次故障的影响面。', T0 + 1000);
    expect(state.status).toBe('awaiting-customer');

    state = await customerSays(state, SCENARIO.objections[0], T0 + 2000);
    expect(state.status).toBe('awaiting-candidate');
    expect(state.objectionCursor).toBe(1);
    expect(state.turns.map((turn) => turn.speaker)).toEqual([
      'customer',
      'candidate',
      'customer',
    ]);
  });

  it('作答不合结果 schema 时拒绝，且状态不变', () => {
    const state = start();
    const rejected = submitCandidateTurn(state, {
      reply: '   ',
      now: T0 + 1000,
      interaction: customerConversationInteraction,
      grantedPermissions: ALL,
    });

    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.code).toBe('invalid-result');
    expect(rejected.state.turns).toHaveLength(1);
    expect(rejected.state.status).toBe('awaiting-candidate');
  });

  it('未渲染过的选项值被拒绝', () => {
    const rejected = submitCandidateTurn(start(), {
      reply: '我理解你的顾虑。',
      intent: 'not-a-rendered-option',
      now: T0 + 1000,
      interaction: customerConversationInteraction,
      grantedPermissions: ALL,
    });

    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.detail).toContain('不是已渲染的选项');
  });

  it('意图标注可以缺失，不阻塞提交', () => {
    const transition = submitCandidateTurn(start(), {
      reply: '我们先把故障复盘对齐。',
      now: T0 + 1000,
      interaction: customerConversationInteraction,
      grantedPermissions: ALL,
    });

    expect(transition.ok).toBe(true);
    expect(transition.state.turns[1]).toMatchObject({ speaker: 'candidate', intent: null });
  });
});

/**
 * 验收要求：超时、取消、崩溃、权限撤销都不破坏 Campaign。
 * 四条路径的共同标准是——收敛成终态、对话记录留存、不抛异常。
 */
describe('四种异常路径都收敛成良性终态', () => {
  it('超时：任何入口先过时限检查，不依赖定时器', () => {
    const state = start();
    const late = T0 + (TOTAL_SECONDS + 1) * 1000;

    const timedOut = checkRolePlayTimeout(state, late);
    expect(timedOut.status).toBe('timeout');
    expect(timedOut.turns).toHaveLength(1);
    expect(timedOut.terminalDetail).toContain('对话记录已保留');

    // 进程被挂起后恢复，第一次提交也应正确收敛而不是照常写入
    const rejected = submitCandidateTurn(state, {
      reply: '抱歉刚才断线了。',
      now: late,
      interaction: customerConversationInteraction,
      grantedPermissions: ALL,
    });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.code).toBe('session-closed');
    expect(rejected.state.status).toBe('timeout');
  });

  it('取消：中止后记录留存，且重复取消幂等', () => {
    const state = submit(start(), '我明白你的压力。', T0 + 1000);
    const cancelled = cancelRolePlaySession(state, T0 + 2000);

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.turns).toHaveLength(2);

    const again = cancelRolePlaySession(cancelled, T0 + 3000);
    expect(again).toEqual(cancelled);
  });

  it('崩溃：模型抛异常先记一次失败并退回等作答，不丢进度', async () => {
    const state = submit(start(), '先说结论：这次我们承担改造成本。', T0 + 1000);
    const transition = await advanceCustomerTurn(state, {
      scenario: SCENARIO,
      generate: async () => {
        throw new Error('模型连接中断');
      },
      now: T0 + 2000,
      grantedPermissions: ALL,
    });

    expect(transition.ok).toBe(true);
    expect(transition.state.status).toBe('awaiting-candidate');
    expect(transition.state.personaFailures).toBe(1);
    // 进度不丢：候选人那轮还在
    expect(transition.state.turns).toHaveLength(2);
  });

  it('崩溃：连续失败超出预算后以 failed 收尾且不抛异常', async () => {
    let state = submit(start(), '我们把方案拆成两步。', T0 + 1000);

    for (let attempt = 0; attempt <= PERSONA_FAILURE_BUDGET; attempt += 1) {
      state.status = 'awaiting-customer';
      const transition = await advanceCustomerTurn(state, {
        scenario: SCENARIO,
        generate: async () => {
          throw new Error('模型连接中断');
        },
        now: T0 + 2000 + attempt,
        grantedPermissions: ALL,
      });
      expect(transition.ok).toBe(true);
      state = transition.state;
    }

    expect(state.status).toBe('failed');
    expect(state.turns).toHaveLength(2);
    expect(state.terminalDetail).toContain('已保留对话记录');
  });

  it('崩溃：返回空串同样计入失败，不写入空台词', async () => {
    const state = submit(start(), '我理解。', T0 + 1000);
    const transition = await advanceCustomerTurn(state, {
      scenario: SCENARIO,
      generate: async () => '   ',
      now: T0 + 2000,
      grantedPermissions: ALL,
    });

    expect(transition.ok).toBe(true);
    expect(transition.state.personaFailures).toBe(1);
    expect(transition.state.turns).toHaveLength(2);
  });

  it('权限撤销：麦克风撤销只失去语音，会话继续', () => {
    const state = submit(start(), '这次我们把责任写进 SLA。', T0 + 1000);
    const next = applyPermissionChange(state, ['llm:complete']);

    expect(next.status).toBe('awaiting-customer');
    expect(isTerminalStatus(next.status)).toBe(false);
    expect(next.voiceEnabled).toBe(false);
  });

  it('权限撤销：麦克风恢复后语音重新可用', () => {
    const withoutMic = applyPermissionChange(start(), ['llm:complete']);
    expect(withoutMic.voiceEnabled).toBe(false);
    expect(applyPermissionChange(withoutMic, ALL).voiceEnabled).toBe(true);
  });

  it('权限撤销：模型权限撤销后收尾，但记录留存', async () => {
    const state = submit(start(), '我先确认一下你最在意的是问责还是价格。', T0 + 1000);
    const transition = await advanceCustomerTurn(state, {
      scenario: SCENARIO,
      generate: async () => {
        throw new Error('不应被调用');
      },
      now: T0 + 2000,
      grantedPermissions: ['microphone:read'],
    });

    expect(transition.ok).toBe(false);
    if (transition.ok) return;
    expect(transition.state.status).toBe('permission-revoked');
    expect(transition.state.turns).toHaveLength(2);
    expect(transition.state.terminalDetail).toContain('记录已保留');
  });

  it('终态之后的任何操作都被拒绝而不是抛异常', async () => {
    const done = completeRolePlaySession(submit(start(), '好的。', T0 + 1000), T0 + 2000);
    expect(done.status).toBe('completed');

    const submitAfter = submitCandidateTurn(done, {
      reply: '再补充一句。',
      now: T0 + 3000,
      interaction: customerConversationInteraction,
      grantedPermissions: ALL,
    });
    expect(submitAfter.ok).toBe(false);

    const advanceAfter = await advanceCustomerTurn(done, {
      scenario: SCENARIO,
      generate: async () => '还有别的问题吗？',
      now: T0 + 4000,
      grantedPermissions: ALL,
    });
    expect(advanceAfter.ok).toBe(false);
    expect(rolePlayRemainingSeconds(done, T0 + 3000)).toBe(0);
  });

  it('不在等待客户回应时推进被拒，状态不变', async () => {
    const state = start();
    const transition = await advanceCustomerTurn(state, {
      scenario: SCENARIO,
      generate: async () => '你说。',
      now: T0 + 1000,
      grantedPermissions: ALL,
    });

    expect(transition.ok).toBe(false);
    if (transition.ok) return;
    expect(transition.code).toBe('not-awaiting-customer');
    expect(transition.state.turns).toHaveLength(1);
  });
});

/** 验收要求：角色状态可恢复。 */
describe('角色状态可恢复', () => {
  it('快照恢复后逐字段一致，并能原样继续对话', async () => {
    let state = submit(start(), '我先把故障时间线过一遍。', T0 + 1000);
    state = await customerSays(state, SCENARIO.objections[0], T0 + 2000);
    state = submit(state, '这次我们把补偿方案写进合同。', T0 + 3000);

    const restored = restoreRolePlayState(snapshotRolePlayState(state));
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.state).toEqual(state);

    // 从恢复的状态继续，与从未中断的结果相同
    const fromRestored = await customerSays(restored.state, '合同怎么写？', T0 + 4000);
    const fromOriginal = await customerSays(state, '合同怎么写？', T0 + 4000);
    expect(fromRestored).toEqual(fromOriginal);
    expect(fromRestored.objectionCursor).toBe(2);
  });

  it('异议进度随快照保留，恢复后不从头再来', async () => {
    let state = submit(start(), '第一轮。', T0 + 1000);
    state = await customerSays(state, SCENARIO.objections[0], T0 + 2000);
    expect(state.objectionCursor).toBe(1);

    const restored = restoreRolePlayState(snapshotRolePlayState(state));
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.state.objectionCursor).toBe(1);
  });

  it('终态也可恢复，供只读查看', () => {
    const cancelled = cancelRolePlaySession(start(), T0 + 1000);
    const restored = restoreRolePlayState(snapshotRolePlayState(cancelled));

    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.state.status).toBe('cancelled');
  });

  it('损坏或来自更新版本的快照返回失败而不是抛异常', () => {
    expect(restoreRolePlayState('not json')).toMatchObject({ ok: false, code: 'malformed' });
    expect(restoreRolePlayState('[]')).toMatchObject({ ok: false, code: 'malformed' });
    expect(restoreRolePlayState('{"stateVersion":1}')).toMatchObject({
      ok: false,
      code: 'malformed',
    });

    const future = JSON.parse(snapshotRolePlayState(start()));
    future.stateVersion = ROLE_PLAY_STATE_VERSION + 1;
    expect(restoreRolePlayState(JSON.stringify(future))).toMatchObject({
      ok: false,
      code: 'unsupported-version',
    });

    const futureInteraction = JSON.parse(snapshotRolePlayState(start()));
    futureInteraction.interactionSchemaVersion = 99;
    expect(restoreRolePlayState(JSON.stringify(futureInteraction))).toMatchObject({
      ok: false,
      code: 'unsupported-version',
    });
  });

  it('剩余时间随时间递减，供倒计时字段渲染', () => {
    const state = start();
    expect(rolePlayRemainingSeconds(state, T0)).toBe(TOTAL_SECONDS);
    expect(rolePlayRemainingSeconds(state, T0 + 60_000)).toBe(TOTAL_SECONDS - 60);
    expect(rolePlayRemainingSeconds(state, T0 + (TOTAL_SECONDS + 100) * 1000)).toBe(0);
  });
});
