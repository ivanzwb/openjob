/**
 * 对话消息的统一外观。用户问题靠右且收窄；助手回答靠左占满可用宽度，
 * 给代码块、表格和 Mermaid 流程图留下空间。
 */
export function ChatBubble({
  role,
  children,
}: {
  role: 'user' | 'assistant';
  children: React.ReactNode;
}): React.JSX.Element {
  const isUser = role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={
          isUser
            ? 'max-w-[85%] rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm text-[var(--color-fg)]'
            : 'w-full rounded-lg border border-[var(--color-border)] bg-black/20 px-3 py-2 text-sm leading-relaxed'
        }
      >
        {children}
      </div>
    </div>
  );
}
