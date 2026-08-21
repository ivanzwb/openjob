import { StreamChat } from './StreamChat';
import { buildNodeFollowUpSystemPrompt } from '@shared/prompts/followUp';

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
  return (
    <div className="flex h-full min-h-[280px] flex-col">
      <StreamChat
        key={nodeId}
        streamKey={`chat:node:${nodeId}`}
        compact
        role="explain"
        campaignId={campaignId}
        nodeId={nodeId}
        sessionKind="nodeFollowUp"
        allowWebSearch={false}
        allowTools={false}
        sessionStorageKey={`openjob:followUpSession:${nodeId}`}
        showSessionHistory={false}
        systemPrompt={buildNodeFollowUpSystemPrompt(nodeName, nodeId)}
        placeholder={`对「${nodeName}」有什么想追问的？`}
      />
    </div>
  );
}
