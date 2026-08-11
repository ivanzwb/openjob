import type { IpcEventChannel, IpcEventMap, IpcInvokeChannel, IpcReq, IpcRes } from '@shared/ipc';
import { subscribeEmit } from '../ipc/bridge';
import { getCampaignOverview } from '../campaign/overview';
import { compareCampaigns } from '../campaign/compare';
import {
  createCampaign,
  deleteCampaign,
  getCampaignDetail,
  listCampaigns,
  listResumes,
  createResume,
  deleteResume,
  updateCampaign,
} from '../campaign/repository';
import { createNode, deleteNode, updateNode } from '../campaign/nodes';
import { createEdge, deleteEdge, listEdges } from '../campaign/edges';
import { applyHistorySignals, getCampaignNudges } from '../insights';
import {
  diagnoseAttachResume,
  diagnoseExpandNode,
  diagnoseFetchIntel,
  diagnoseFromJd,
  ingestInterviewReport,
  ingestWebReports,
  listReports,
} from '../diagnosis';
import {
  createAnnotation,
  deleteAnnotation,
  listAnnotations,
  listAnnotationsForCampaign,
  listCodeAnnotations,
  toggleBookmark,
} from '../annotation';
import { generateDesignCase, submitDesignAnswer } from '../design';
import { generateExplanation, generateFallbackScript, getExplanation, updateExplanation, elaborateExplanationSelection, rewriteExplanationSelection } from '../explain';
import { startJob } from '../jobs';
import { cancelStream, startChat, testTier } from '../llm';
import {
  completeTask,
  deferToday,
  generatePlan,
  getTodayPlan,
  listTodayCampaigns,
  skipTask,
} from '../plan/schedule';
import {
  addTask,
  deleteTask,
  listPlanDates,
  moveTaskToDate,
  reorderTasks,
  updateTaskMinutes,
} from '../plan/edit';
import { generateQuizQuestion, submitQuizAnswer } from '../quiz';
import {
  deleteRepo,
  ensureCodeRef,
  getRepo,
  listRepos,
  readRepoFile,
} from '../repo';
import { cloneAndIndex } from '../repo/repository';
import { fetchUrl, search } from '../search';
import {
  deleteSpeechSnippet,
  listSpeechSnippets,
  saveSpeechFromNode,
  saveSpeechFromRepo,
  updateSpeechSnippet,
} from '../speech';
import {
  deleteSession,
  getSessionMessages,
  listSessions,
  searchSessions,
} from '../session';

type RpcHandler = (payload: unknown) => Promise<unknown> | unknown;

/**
 * 手机端可调用的主进程能力白名单。
 * 配置/密钥/文件对话框/导出等桌面专属能力不在此列。
 */
const RPC_HANDLERS: Partial<Record<IpcInvokeChannel, RpcHandler>> = {
  'campaign:list': () => listCampaigns(),
  'campaign:getOverview': () => getCampaignOverview(),
  'campaign:compare': (p) => compareCampaigns((p as { campaignIdA: string; campaignIdB: string }).campaignIdA, (p as { campaignIdA: string; campaignIdB: string }).campaignIdB),
  'campaign:get': (p) => getCampaignDetail((p as { id: string }).id),
  'campaign:create': (p) => createCampaign(p as IpcReq<'campaign:create'>),
  'campaign:update': (p) => updateCampaign(p as IpcReq<'campaign:update'>),
  'campaign:delete': (p) => {
    deleteCampaign((p as { id: string }).id);
  },
  'resume:list': () => listResumes(),
  'resume:create': (p) => createResume((p as { label: string; rawText: string }).label, (p as { label: string; rawText: string }).rawText),
  'resume:delete': (p) => deleteResume((p as { id: string }).id),
  'diagnosis:fromJd': (p) => ({
    jobId: startJob('JD 诊断', (jobId) => diagnoseFromJd((p as { campaignId: string }).campaignId, jobId)),
  }),
  'diagnosis:attachResume': (p) => ({
    jobId: startJob('简历交叉分析', (jobId) =>
      diagnoseAttachResume(
        (p as { campaignId: string; resumeId: string }).campaignId,
        (p as { campaignId: string; resumeId: string }).resumeId,
        jobId,
      ),
    ),
  }),
  'diagnosis:expandNode': (p) => ({
    jobId: startJob('细化考点', (jobId) => diagnoseExpandNode((p as { nodeId: string }).nodeId, jobId)),
  }),
  'diagnosis:fetchIntel': (p) => ({
    jobId: startJob('公司情报', (jobId) => diagnoseFetchIntel((p as { campaignId: string }).campaignId, jobId)),
  }),
  'diagnosis:ingestReport': (p) => {
    const input = p as IpcReq<'diagnosis:ingestReport'>;
    return ingestInterviewReport(input.campaignId, input.rawText, input.sourceType);
  },
  'diagnosis:ingestWeb': (p) => ingestWebReports((p as { campaignId: string }).campaignId),
  'diagnosis:listReports': (p) => listReports((p as { campaignId: string }).campaignId),
  'node:update': (p) => updateNode(p as IpcReq<'node:update'>),
  'node:delete': (p) => deleteNode((p as { id: string }).id),
  'node:create': (p) => createNode(p as IpcReq<'node:create'>),
  'edge:list': (p) => listEdges((p as { campaignId: string }).campaignId),
  'edge:create': (p) => createEdge(p as IpcReq<'edge:create'>),
  'edge:delete': (p) => deleteEdge((p as { id: string }).id),
  'insight:nudges': (p) => getCampaignNudges((p as { campaignId: string }).campaignId),
  'insight:applyHistory': (p) => applyHistorySignals((p as { campaignId: string }).campaignId),
  'plan:generate': (p) => {
    const input = p as IpcReq<'plan:generate'>;
    return generatePlan(input.campaignId, input.interviewDate, input.dailyMinutes);
  },
  'plan:listTodayCampaigns': () => listTodayCampaigns(),
  'plan:getToday': (p) =>
    getTodayPlan(
      (p as { campaignId?: string }).campaignId,
      (p as { date?: string }).date,
    ),
  'plan:deferToday': (p) => ({ deferred: deferToday((p as { campaignId: string }).campaignId) }),
  'plan:listDates': (p) => listPlanDates((p as { campaignId: string }).campaignId),
  'task:complete': (p) => completeTask((p as { taskId: string; actualMinutes?: number }).taskId, (p as { taskId: string; actualMinutes?: number }).actualMinutes),
  'task:skip': (p) => skipTask((p as { taskId: string }).taskId),
  'task:reorder': (p) => reorderTasks((p as { planDayId: string; taskIds: string[] }).planDayId, (p as { planDayId: string; taskIds: string[] }).taskIds),
  'task:move': (p) => moveTaskToDate((p as { taskId: string; date: string }).taskId, (p as { taskId: string; date: string }).date),
  'task:delete': (p) => deleteTask((p as { taskId: string }).taskId),
  'task:add': (p) => ({ taskId: addTask(p as IpcReq<'task:add'>) }),
  'task:setMinutes': (p) => updateTaskMinutes((p as { taskId: string; estMinutes: number }).taskId, (p as { taskId: string; estMinutes: number }).estMinutes),
  'explain:get': (p) => {
    const input = p as IpcReq<'explain:get'>;
    return getExplanation(input.nodeId, input.tier);
  },
  'explain:generate': (p) => {
    const input = p as IpcReq<'explain:generate'>;
    return generateExplanation(input.nodeId, input.tier);
  },
  'explain:fallback': (p) => generateFallbackScript((p as { nodeId: string }).nodeId),
  'explain:update': (p) => {
    const input = p as IpcReq<'explain:update'>;
    return updateExplanation(input.id, input.contentMd);
  },
  'explain:elaborate': (p) => {
    const input = p as IpcReq<'explain:elaborate'>;
    return elaborateExplanationSelection(
      input.nodeId,
      input.tier,
      input.selectedText,
      input.contextMd,
    );
  },
  'explain:rewrite': (p) => {
    const input = p as IpcReq<'explain:rewrite'>;
    return rewriteExplanationSelection(
      input.nodeId,
      input.tier,
      input.selectedText,
      input.contextMd,
    );
  },
  'quiz:question': (p) => generateQuizQuestion((p as { nodeId: string }).nodeId),
  'quiz:submit': (p) => {
    const input = p as IpcReq<'quiz:submit'>;
    return submitQuizAnswer(input.nodeId, input.question, input.userAnswer);
  },
  'repo:list': () => listRepos(),
  'repo:get': (p) => getRepo((p as { id: string }).id),
  'repo:add': (p) => ({
    jobId: startJob('克隆并索引仓库', (jobId) => cloneAndIndex((p as { url: string }).url, jobId)),
  }),
  'repo:delete': (p) => deleteRepo((p as { id: string }).id),
  'repo:readFile': (p) => {
    const input = p as IpcReq<'repo:readFile'>;
    return readRepoFile(input.repoId, input.filePath, input.startLine, input.endLine);
  },
  'speech:save': (p) => {
    const input = p as IpcReq<'speech:save'>;
    return saveSpeechFromRepo(input.repoId, input.contentMd, input.tier);
  },
  'speech:saveFromNode': (p) => {
    const input = p as IpcReq<'speech:saveFromNode'>;
    return saveSpeechFromNode(input.nodeId, input.contentMd, input.tier);
  },
  'speech:list': () => listSpeechSnippets(),
  'speech:update': (p) => {
    const input = p as IpcReq<'speech:update'>;
    return updateSpeechSnippet(input.id, input.contentMd);
  },
  'speech:delete': (p) => deleteSpeechSnippet((p as { id: string }).id),
  'design:case': (p) => {
    const input = p as IpcReq<'design:case'>;
    return generateDesignCase(input.campaignId, input.interviewType ?? 'mixed');
  },
  'design:submit': (p) => {
    const input = p as IpcReq<'design:submit'>;
    return submitDesignAnswer(
      input.campaignId,
      input.caseTitle,
      input.scenarioMd,
      input.userAnswer,
      input.interviewType,
    );
  },
  'annotation:list': (p) => listAnnotations((p as { targetType: string; targetId: string }).targetType as IpcReq<'annotation:list'>['targetType'], (p as { targetType: string; targetId: string }).targetId),
  'annotation:listForCampaign': (p) => listAnnotationsForCampaign((p as { campaignId: string }).campaignId),
  'annotation:listForRepo': (p) => listCodeAnnotations((p as { repoId: string }).repoId),
  'annotation:create': (p) => createAnnotation(p as IpcReq<'annotation:create'>),
  'annotation:delete': (p) => deleteAnnotation((p as { id: string }).id),
  'annotation:toggleBookmark': (p) => toggleBookmark((p as { targetType: string; targetId: string }).targetType as IpcReq<'annotation:toggleBookmark'>['targetType'], (p as { targetType: string; targetId: string }).targetId),
  'codeRef:ensure': (p) => ({ id: ensureCodeRef(p as IpcReq<'codeRef:ensure'>) }),
  'session:list': (p) => listSessions((p as { kind?: string; limit?: number }).kind as IpcReq<'session:list'>['kind'], (p as { kind?: string; limit?: number }).limit),
  'session:getMessages': (p) => getSessionMessages((p as { sessionId: string }).sessionId),
  'session:search': (p) => searchSessions((p as { query: string; limit?: number }).query, (p as { query: string; limit?: number }).limit),
  'session:delete': (p) => deleteSession((p as { sessionId: string }).sessionId),
  'llm:testTier': (p) => testTier((p as { tier: string }).tier as IpcReq<'llm:testTier'>['tier']),
  'llm:chat': (p) => startChat(p as IpcReq<'llm:chat'>),
  'llm:cancel': (p) => cancelStream((p as { streamId: string }).streamId),
  'search:query': (p) => search(p as IpcReq<'search:query'>),
  'search:fetchUrl': (p) => fetchUrl(p as IpcReq<'search:fetchUrl'>),
};

export async function invokeRpc<C extends IpcInvokeChannel>(
  channel: C,
  payload: IpcReq<C>,
): Promise<IpcRes<C>> {
  const handler = RPC_HANDLERS[channel];
  if (!handler) throw new Error(`RPC 通道未开放：${channel}`);
  return (await handler(payload)) as IpcRes<C>;
}

export function isStreamChannel(channel: IpcInvokeChannel): boolean {
  return channel === 'llm:chat';
}

export function isJobChannel(channel: IpcInvokeChannel): boolean {
  return [
    'diagnosis:fromJd',
    'diagnosis:attachResume',
    'diagnosis:expandNode',
    'diagnosis:fetchIntel',
    'repo:add',
  ].includes(channel);
}

/** 等待一次流式会话或长任务结束 */
export function waitForStreamEvents(
  streamId: string,
  timeoutMs = 120_000,
): Promise<{ events: Array<{ channel: IpcEventChannel; payload: IpcEventMap[IpcEventChannel] }> }> {
  return new Promise((resolve, reject) => {
    const events: Array<{ channel: IpcEventChannel; payload: IpcEventMap[IpcEventChannel] }> = [];
    const timer = setTimeout(() => {
      off();
      reject(new Error('RPC 流式请求超时'));
    }, timeoutMs);

    const off = subscribeEmit((channel, payload) => {
      const p = payload as { streamId?: string; jobId?: string; done?: boolean };
      if ('streamId' in payload && (payload as { streamId: string }).streamId === streamId) {
        events.push({ channel, payload });
        if (channel === 'stream:done' || channel === 'stream:error') {
          clearTimeout(timer);
          off();
          resolve({ events });
        }
        return;
      }
      if ('jobId' in payload && p.jobId === streamId) {
        events.push({ channel, payload });
        if (channel === 'job:progress' && p.done) {
          clearTimeout(timer);
          off();
          resolve({ events });
        }
      }
    });
  });
}
