import React, { useEffect, useState } from 'react';

import {
  INTERACTION_TERMINAL_LABELS,
  isInteractionTerminalStatus,
  type RenderableInteractionField,
  type RolePlaySessionView,
} from '@core/plugins/interactions';
import { invoke } from '../ipc';
import { runTask, useTask, useTaskResult } from '../ipc/taskStore';

/**
 * 读回上一次的会话。
 *
 * 快照自带全部角色状态，所以恢复不需要问主进程要会话——主进程本来就没存。
 */
function readStoredSession(storageKey: string): RolePlaySessionView | null {
  const stored = window.localStorage.getItem(storageKey);
  if (!stored) return null;
  try {
    return JSON.parse(stored) as RolePlaySessionView;
  } catch {
    window.localStorage.removeItem(storageKey);
    return null;
  }
}

/**
 * 客户对话模拟的宿主渲染器。
 *
 * 整个组件就是一个对封闭字段类型集的 switch——这正是不接受任意 JSON Schema 换来的
 * 好处：字段类型有限，宿主对每一种都有确定画法，插件想加新控件必须先让 Core 支持，
 * 而不是自己塞一个组件进来。
 *
 * 不认识的类型到不了这里：buildInteractionHostView 判定不可渲染时 fields 直接为空，
 * 界面只显示降级说明。宁可整块退回只读，也不半渲染一个自己没把握的界面。
 *
 * 快照落 localStorage：一轮对练是分钟级的多次模型调用，切个页面回来就得从头开口
 * 等于把刚才那几轮连同客户的情绪线索一起丢掉。
 */
export function RolePlayRunner({ campaignId }: { campaignId: string }): React.JSX.Element {
  const storageKey = `openjob:roleplay:${campaignId}`;

  const [session, setSession] = useState<RolePlaySessionView | null>(() =>
    readStoredSession(storageKey),
  );
  const [reply, setReply] = useState('');
  const [intent, setIntent] = useState('');
  const [scope, setScope] = useState(storageKey);

  // 换 Campaign 时重新读快照。渲染期比对而不是放进 effect：effect 里同步 setState
  // 会先渲染一帧上一场的对话再被换掉，用户能看见那一闪
  if (scope !== storageKey) {
    setScope(storageKey);
    setSession(readStoredSession(storageKey));
    setReply('');
    setIntent('');
  }
  const startKey = `roleplay:start:${campaignId}`;
  const turnKey = `roleplay:turn:${campaignId}`;
  const endKey = `roleplay:end:${campaignId}`;

  const startTask = useTask(startKey);
  const turnTask = useTask(turnKey);
  const endTask = useTask(endKey);
  const error = startTask.error ?? turnTask.error ?? endTask.error;
  const busy = startTask.running || turnTask.running || endTask.running;

  // 麦克风是操作系统层面的授权，只有渲染进程看得见；主进程据此决定语音是否可用
  const [microphoneAvailable, setMicrophoneAvailable] = useState(false);

  useEffect(() => {
    if (!navigator.permissions?.query) return;
    navigator.permissions
      .query({ name: 'microphone' as PermissionName })
      .then((status) => {
        setMicrophoneAvailable(status.state === 'granted');
        status.onchange = (): void => setMicrophoneAvailable(status.state === 'granted');
      })
      .catch(() => setMicrophoneAvailable(false));
  }, []);

  const accept = (next: RolePlaySessionView): void => {
    setSession(next);
    window.localStorage.setItem(storageKey, JSON.stringify(next));
    if (next.rejection === null) {
      setReply('');
      setIntent('');
    }
  };

  useTaskResult<RolePlaySessionView>(startKey, accept);
  useTaskResult<RolePlaySessionView>(turnKey, accept);
  useTaskResult<RolePlaySessionView>(endKey, accept);

  const start = (): void => {
    void runTask(startKey, () =>
      invoke('interaction:startRolePlay', { campaignId, microphoneAvailable }),
    ).catch(() => undefined);
  };

  const submit = (): void => {
    if (!session || !reply.trim()) return;
    void runTask(turnKey, () =>
      invoke('interaction:submitRolePlayTurn', {
        campaignId,
        snapshot: session.snapshot,
        reply: reply.trim(),
        intent: intent || undefined,
        microphoneAvailable,
      }),
    ).catch(() => undefined);
  };

  const end = (action: 'cancel' | 'complete'): void => {
    if (!session) return;
    void runTask(endKey, () =>
      invoke('interaction:endRolePlay', {
        campaignId,
        snapshot: session.snapshot,
        action,
        microphoneAvailable,
      }),
    ).catch(() => undefined);
  };

  if (!session) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-[var(--color-muted)]">
          客户对话模拟：由模型扮演客户，你按真实节奏应对。可以语音，也可以打字。
        </p>
        <button
          type="button"
          onClick={start}
          disabled={busy}
          className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          {startTask.running ? '正在准备场景…' : '开始对练'}
        </button>
        {error ? <p className="text-xs text-red-400">{error}</p> : null}
      </div>
    );
  }

  const { view, values } = session;

  // 本机渲染不了就只显示降级说明。这段与手机端共用同一份判定结果，
  // 不存在两端各自解释 schema 的余地
  if (!view.renderable) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-[var(--color-muted)]">{session.scenarioTitle}</p>
        <p className="text-xs text-amber-300">{view.detail}</p>
        {values.transcript.length > 0 ? <Transcript turns={values.transcript} /> : null}
      </div>
    );
  }

  const terminal = isInteractionTerminalStatus(session.status);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{session.scenarioTitle}</h3>
        {terminal ? (
          <span className="text-xs text-amber-300">
            {INTERACTION_TERMINAL_LABELS[session.status as keyof typeof INTERACTION_TERMINAL_LABELS]}
          </span>
        ) : null}
      </div>

      {view.fields.map((field) => (
        <Field
          key={field.id}
          field={field}
          session={session}
          reply={reply}
          intent={intent}
          disabled={terminal || busy}
          onReplyChange={setReply}
          onIntentChange={setIntent}
        />
      ))}

      {session.rejection ? (
        <p className="text-xs text-amber-300">{session.rejection.detail}</p>
      ) : null}
      {session.terminalDetail ? (
        <p className="text-xs text-[var(--color-muted)]">{session.terminalDetail}</p>
      ) : null}
      {error ? <p className="text-xs text-red-400">{error}</p> : null}

      {terminal ? (
        <button
          type="button"
          onClick={() => {
            window.localStorage.removeItem(storageKey);
            setSession(null);
          }}
          className="rounded border border-[var(--color-border)] px-3 py-1.5 text-sm"
        >
          再练一轮
        </button>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={submit}
            disabled={busy || !reply.trim()}
            className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            {turnTask.running ? '客户正在回应…' : '回应客户'}
          </button>
          <button
            type="button"
            onClick={() => end('complete')}
            disabled={busy}
            className="rounded border border-[var(--color-border)] px-3 py-1.5 text-sm"
          >
            结束并交卷
          </button>
          <button
            type="button"
            onClick={() => end('cancel')}
            disabled={busy}
            className="rounded border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-muted)]"
          >
            中止
          </button>
        </div>
      )}
    </div>
  );
}

function Transcript({
  turns,
}: {
  turns: RolePlaySessionView['values']['transcript'];
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      {turns.map((turn, index) => (
        <div key={`${turn.at}-${index}`} className="text-sm">
          <span
            className={
              turn.speaker === 'customer'
                ? 'text-[var(--color-accent)]'
                : 'text-[var(--color-muted)]'
            }
          >
            {turn.speaker === 'customer' ? '客户' : '你'}
          </span>
          <span className="ml-2 whitespace-pre-wrap">{turn.text}</span>
        </div>
      ))}
    </div>
  );
}

function formatRemaining(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${String(seconds % 60).padStart(2, '0')} 秒`;
}

/**
 * 按字段类型渲染。
 *
 * switch 的分支与 INTERACTION_FIELD_KINDS 一一对应；类型集封闭，所以这里不需要
 * 兜底分支去猜一个不认识的类型该长什么样。
 */
function Field({
  field,
  session,
  reply,
  intent,
  disabled,
  onReplyChange,
  onIntentChange,
}: {
  field: RenderableInteractionField;
  session: RolePlaySessionView;
  reply: string;
  intent: string;
  disabled: boolean;
  onReplyChange: (value: string) => void;
  onIntentChange: (value: string) => void;
}): React.JSX.Element | null {
  const { values } = session;

  switch (field.kind) {
    case 'note':
      return (
        <section className="space-y-1">
          <h4 className="text-xs text-[var(--color-muted)]">{field.label}</h4>
          <p className="text-sm">{values.scenario}</p>
        </section>
      );

    case 'factList':
      return (
        <section className="space-y-1">
          <h4 className="text-xs text-[var(--color-muted)]">{field.label}</h4>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            {values.persona.map((fact) => (
              <React.Fragment key={fact.label}>
                <dt className="text-[var(--color-muted)]">{fact.label}</dt>
                <dd>{fact.value}</dd>
              </React.Fragment>
            ))}
          </dl>
        </section>
      );

    case 'transcript':
      return (
        <section className="space-y-1">
          <h4 className="text-xs text-[var(--color-muted)]">{field.label}</h4>
          <Transcript turns={values.transcript} />
        </section>
      );

    case 'countdown':
      return (
        <p className="text-xs text-[var(--color-muted)]">
          {field.label}：{formatRemaining(values.remainingSeconds)}
        </p>
      );

    case 'reply':
      return (
        <section className="space-y-1">
          <div className="flex items-baseline justify-between">
            <h4 className="text-xs text-[var(--color-muted)]">{field.label}</h4>
            {field.voiceNotice ? (
              <span className="text-[10px] text-amber-300">{field.voiceNotice}</span>
            ) : null}
          </div>
          <textarea
            value={reply}
            maxLength={field.maxChars}
            disabled={disabled}
            onChange={(event) => onReplyChange(event.target.value)}
            rows={5}
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm disabled:opacity-50"
            placeholder={field.voiceEnabled ? '可以直接说，也可以在这里打字' : '在这里打字作答'}
          />
        </section>
      );

    case 'choice':
      return (
        <section className="space-y-1">
          <h4 className="text-xs text-[var(--color-muted)]">{field.label}</h4>
          <select
            value={intent}
            disabled={disabled}
            onChange={(event) => onIntentChange(event.target.value)}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm disabled:opacity-50"
          >
            <option value="">不标注</option>
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </section>
      );
  }
}
