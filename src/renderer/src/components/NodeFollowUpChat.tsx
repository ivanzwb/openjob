import { StreamChat } from './StreamChat';

/** 考点学习内的多轮追问，绑定战役与考点上下文 */
export function NodeFollowUpChat({
  campaignId,
  nodeId,
  nodeName,
}: {
  campaignId: string;
  nodeId: string;
  nodeName: string;
}): React.JSX.Element {
  const systemPrompt =
    `用户正在备考，当前学习的考点是「${nodeName}」（nodeId: ${nodeId}）。` +
    '请围绕该考点回答追问：澄清概念、对比易混点、补充面试深挖角度。' +
    '回答适合口述；必要时可用知识图谱工具查询或更新掌握度。';

  return (
    <div className="flex h-full min-h-[280px] flex-col">
      <StreamChat
        key={nodeId}
        compact
        role="explain"
        campaignId={campaignId}
        sessionKind="nodeFollowUp"
        systemPrompt={systemPrompt}
        placeholder={`对「${nodeName}」有什么想追问的？`}
      />
    </div>
  );
}
