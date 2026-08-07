import { useCallback, useEffect, useState } from 'react';
import type { SessionMessageView } from '@shared/ipc';
import { invoke } from '../ipc';
import { MarkdownContent } from './MarkdownContent';

/**
 * 排期决策记录。
 *
 * 「为什么这个考点排在第一天」这种问题，事后没有记录就只能靠猜。
 * 默认折叠——它是给想追问的人看的，不该抢主流程的注意力。
 */
export function PlanDecisionLog({
  campaignId,
  reloadKey,
}: {
  campaignId: string;
  reloadKey: number;
}): React.JSX.Element | null {
  const [messages, setMessages] = useState<SessionMessageView[]>([]);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    void invoke('session:list', { kind: 'planning', limit: 100 })
      .then((sessions) => {
        const mine = sessions.find((s) => s.campaignId === campaignId);
        return mine ? invoke('session:getMessages', { sessionId: mine.id }) : [];
      })
      .then(setMessages);
  }, [campaignId]);

  useEffect(load, [load, reloadKey]);

  if (messages.length === 0) return null;

  return (
    <div className="space-y-2 border-t border-[var(--color-border)] pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-sky-400 hover:underline"
      >
        {open ? '收起排期决策记录' : `排期决策记录（${messages.length} 条）`}
      </button>
      {open && (
        <div className="max-h-80 space-y-3 overflow-y-auto rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs">
          {[...messages].reverse().map((m) => (
            <div key={m.id} className="border-b border-[var(--color-border)] pb-3 last:border-0">
              <MarkdownContent text={m.contentMd} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
