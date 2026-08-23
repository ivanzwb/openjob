import { app, BrowserWindow } from 'electron';
import { getConfig, deleteSecret, hasSecret, setSecret, updateConfig } from '../config';
import { getCampaignOverview } from '../campaign/overview';
import { compareCampaigns } from '../campaign/compare';
import {
  createCampaign,
  createResume,
  deleteCampaign,
  deleteResume,
  getCampaignDetail,
  listCampaigns,
  listResumes,
  updateCampaign,
  updateResume,
} from '../campaign/repository';
import {
  createJobTarget,
  deleteJobTarget,
  getJobTarget,
  listJobTargets,
  updateJobTarget,
} from '../jobTarget/repository';
import { optimizeResumeForJobTarget } from '../resume/optimize';
import { exportResumePdf } from '../resume/pdf';
import { polishResumeSection, structureResumeWithLlm } from '../resume/ai';
import {
  deleteResumeVariant,
  getResumeVariant,
  listResumeVariants,
  updateResumeVariant,
} from '../resume/variantRepository';
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
import { generateDesignCase, submitDesignAnswer, updateDesignCaseAnswers, generateRecommendedAnswer, elaborateDesignAnswer } from '../design';
import { dbHealth } from '../db';
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
import { generateQuizAnswer, generateQuizQuestion, submitQuizAnswer } from '../quiz';
import {
  cloneAndIndex,
  deleteRepo,
  ensureCodeRef,
  getGitStatus,
  getRepo,
  listRepos,
  readRepoFile,
} from '../repo';
import { clearCache, fetchUrl, search } from '../search';
import {
  deleteSpeechSnippet,
  exportSpeechSnippets,
  listSpeechSnippets,
  listSpeechSnippetsForSource,
  saveSpeechFromDesign,
  saveSpeechFromNode,
  saveSpeechFromQuizNode,
  saveSpeechFromRepo,
  updateSpeechSnippet,
} from '../speech';
import {
  bindSessionToNode,
  deleteSession,
  deleteSessionsForNode,
  getNodeFollowUpMessages,
  getSessionMessages,
  listSessions,
  searchSessions,
} from '../session';
import { getAppPaths } from '../paths';
import { getSttStatus, transcribe } from '../stt';
import { checkForUpdates, getUpdateStatus, quitAndInstall } from '../updater';
import { handle } from './bridge';
import { applyWindowTheme } from '../theme';
import { importResumeFromFile } from '../campaign/resumeImport';
import {
  beginPairing,
  createBackup,
  deleteBackup,
  endPairing,
  getSyncStatus,
  listBackups,
  listPeers,
  listRunOverwrites,
  listSyncRuns,
  pruneBackups,
  removePeer,
  restoreBackup,
} from '../sync';

function currentWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((win) => !win.isDestroyed());
}

export function registerIpcHandlers(): void {
  handle('app:getPaths', () => getAppPaths());
  handle('app:getVersion', () => app.getVersion());
  handle('window:getState', () => ({ maximized: currentWindow()?.isMaximized() ?? false }));
  handle('window:minimize', () => {
    currentWindow()?.minimize();
  });
  handle('window:toggleMaximize', () => {
    const win = currentWindow();
    if (!win) return { maximized: false };
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
    return { maximized: win.isMaximized() };
  });
  handle('window:close', () => {
    currentWindow()?.close();
  });

  handle('update:status', () => getUpdateStatus());
  handle('update:check', () => checkForUpdates());
  handle('update:install', () => quitAndInstall());

  handle('config:get', () => getConfig());
  handle('config:update', (next) => {
    const merged = updateConfig(next);
    applyWindowTheme(merged.ui.theme);
    return merged;
  });
  handle('config:setSecret', ({ ref, value }) => setSecret(ref, value));
  handle('config:hasSecret', ({ ref }) => hasSecret(ref));
  handle('config:deleteSecret', ({ ref }) => deleteSecret(ref));

  handle('llm:testTier', ({ tier }) => testTier(tier));
  handle('llm:chat', (req) => startChat(req));
  handle('llm:cancel', ({ streamId }) => cancelStream(streamId));

  handle('search:query', (req) => search(req));
  handle('search:fetchUrl', (req) => fetchUrl(req));
  handle('search:clearCache', () => ({ removed: clearCache() }));

  handle('db:health', () => dbHealth());

  handle('campaign:list', () => listCampaigns());
  handle('campaign:getOverview', () => getCampaignOverview());
  handle('campaign:compare', ({ campaignIdA, campaignIdB }) =>
    compareCampaigns(campaignIdA, campaignIdB),
  );
  handle('campaign:get', ({ id }) => getCampaignDetail(id));
  handle('campaign:create', (input) => createCampaign(input));
  handle('campaign:update', (input) => updateCampaign(input));
  handle('campaign:delete', ({ id }) => {
    deleteCampaign(id);
  });

  handle('resume:list', () => listResumes());
  // 导入/粘贴的纯文本先用模型归类成固定模块，模型不可用时退回规则识别
  handle('resume:create', async (input) => {
    const structured = await structureResumeWithLlm(input.rawText);
    return { ...createResume(input.label, structured.contentMd), fallbackReason: structured.fallbackReason };
  });
  handle('resume:update', (input) => updateResume(input));
  handle('resume:importFile', () => importResumeFromFile());
  handle('resume:delete', ({ id }) => {
    deleteResume(id);
  });
  handle('resume:exportPdf', (input) => exportResumePdf(input));
  handle('resume:aiStructure', (input) => structureResumeWithLlm(input.contentMd));
  handle('resume:aiPolish', async (input) => ({
    contentMd: await polishResumeSection(input),
  }));

  handle('jobTarget:list', () => listJobTargets());
  handle('jobTarget:get', ({ id }) => getJobTarget(id));
  handle('jobTarget:create', (input) => createJobTarget(input));
  handle('jobTarget:update', (input) => updateJobTarget(input));
  handle('jobTarget:delete', ({ id }) => {
    deleteJobTarget(id);
  });

  handle('resumeVariant:list', (input) =>
    listResumeVariants(
      input && typeof input === 'object'
        ? {
            jobTargetId: (input as { jobTargetId?: string }).jobTargetId,
            sourceResumeId: (input as { sourceResumeId?: string }).sourceResumeId,
          }
        : undefined,
    ),
  );
  handle('resumeVariant:get', ({ id }) => getResumeVariant(id));
  handle('resumeVariant:optimize', (input) =>
    optimizeResumeForJobTarget(input.sourceResumeId, input.jobTargetId),
  );
  handle('resumeVariant:update', (input) => updateResumeVariant(input));
  handle('resumeVariant:delete', ({ id }) => {
    deleteResumeVariant(id);
  });

  handle('diagnosis:fromJd', ({ campaignId }) => ({
    jobId: startJob('JD 诊断', (jobId) => diagnoseFromJd(campaignId, jobId)),
  }));
  handle('diagnosis:attachResume', ({ campaignId, resumeId }) => ({
    jobId: startJob('简历交叉分析', (jobId) =>
      diagnoseAttachResume(campaignId, resumeId, jobId),
    ),
  }));
  handle('diagnosis:expandNode', ({ nodeId }) => ({
    jobId: startJob('细化考点', (jobId) => diagnoseExpandNode(nodeId, jobId)),
  }));
  handle('diagnosis:fetchIntel', ({ campaignId }) => ({
    jobId: startJob('公司情报', (jobId) => diagnoseFetchIntel(campaignId, jobId)),
  }));
  handle('diagnosis:ingestReport', ({ campaignId, rawText, sourceType }) =>
    ingestInterviewReport(campaignId, rawText, sourceType),
  );
  handle('diagnosis:ingestWeb', async ({ campaignId }) => {
    const { reports, sourcesFetched } = await ingestWebReports(campaignId);
    return {
      reports,
      sourcesFetched,
      totalQuestions: reports.reduce((s, r) => s + r.questionsExtracted, 0),
      totalNodesUpdated: reports.reduce((s, r) => s + r.nodesUpdated, 0),
    };
  });
  handle('diagnosis:listReports', ({ campaignId }) => listReports(campaignId));

  handle('node:update', (input) => updateNode(input));
  handle('node:delete', ({ id }) => {
    deleteNode(id);
  });
  handle('node:create', (input) => createNode(input));

  handle('edge:list', ({ campaignId }) => listEdges(campaignId));
  handle('edge:create', (input) => createEdge(input));
  handle('edge:delete', ({ id }) => {
    deleteEdge(id);
  });

  handle('insight:nudges', ({ campaignId }) => getCampaignNudges(campaignId));
  handle('insight:applyHistory', ({ campaignId }) => applyHistorySignals(campaignId));

  handle('plan:generate', ({ campaignId, interviewDate, dailyMinutes }) =>
    generatePlan(campaignId, interviewDate, dailyMinutes),
  );
  handle('plan:listTodayCampaigns', () => listTodayCampaigns());
  handle('plan:getToday', ({ campaignId, date }) => getTodayPlan(campaignId, date));
  handle('plan:deferToday', ({ campaignId }) => ({ deferred: deferToday(campaignId) }));
  handle('plan:listDates', ({ campaignId }) => listPlanDates(campaignId));

  handle('task:complete', ({ taskId, actualMinutes }) => completeTask(taskId, actualMinutes));
  handle('task:skip', ({ taskId }) => skipTask(taskId));
  handle('task:reorder', ({ planDayId, taskIds }) => {
    reorderTasks(planDayId, taskIds);
  });
  handle('task:move', ({ taskId, date }) => {
    moveTaskToDate(taskId, date);
  });
  handle('task:delete', ({ taskId }) => {
    deleteTask(taskId);
  });
  handle('task:add', (input) => ({ taskId: addTask(input) }));
  handle('task:setMinutes', ({ taskId, estMinutes }) => {
    updateTaskMinutes(taskId, estMinutes);
  });

  handle('explain:get', ({ nodeId, tier }) => getExplanation(nodeId, tier));
  handle('explain:generate', ({ nodeId, tier, instruction }) =>
    generateExplanation(nodeId, tier, instruction),
  );
  handle('explain:fallback', ({ nodeId, instruction }) =>
    generateFallbackScript(nodeId, instruction),
  );
  handle('explain:update', ({ id, contentMd }) => updateExplanation(id, contentMd));
  handle('explain:elaborate', ({ nodeId, tier, selectedText, contextMd }) =>
    elaborateExplanationSelection(nodeId, tier, selectedText, contextMd),
  );
  handle('explain:rewrite', ({ nodeId, tier, selectedText, contextMd }) =>
    rewriteExplanationSelection(nodeId, tier, selectedText, contextMd),
  );

  handle('quiz:question', ({ nodeId }) => generateQuizQuestion(nodeId));
  handle('quiz:answer', ({ nodeId, question }) => generateQuizAnswer(nodeId, question));
  handle('quiz:submit', (input) => submitQuizAnswer(input.nodeId, input.question, input.userAnswer));

  handle('repo:gitStatus', () => getGitStatus());
  handle('repo:list', () => listRepos());
  handle('repo:get', ({ id }) => getRepo(id));
  handle('repo:add', (input) => ({
    jobId: startJob('克隆并索引仓库', (jobId) => cloneAndIndex(input.url, jobId)),
  }));
  handle('repo:delete', ({ id }) => {
    deleteRepo(id);
  });
  handle('repo:readFile', ({ repoId, filePath, startLine, endLine }) =>
    readRepoFile(repoId, filePath, startLine, endLine),
  );

  handle('speech:save', (input) => saveSpeechFromRepo(input.repoId, input.contentMd, input.tier));
  handle('speech:saveFromNode', (input) =>
    saveSpeechFromNode(input.nodeId, input.contentMd, input.tier),
  );
  handle('speech:saveFromDesign', (input) =>
    saveSpeechFromDesign(input.campaignId, '', input.contentMd),
  );
  handle('speech:saveFromQuiz', (input) => saveSpeechFromQuizNode(input.nodeId, input.contentMd));
  handle('speech:list', () => listSpeechSnippets());
  handle('speech:listForSource', ({ sourceType, sourceId }) =>
    listSpeechSnippetsForSource(sourceType, sourceId),
  );
  handle('speech:update', (input) => updateSpeechSnippet(input.id, input.contentMd));
  handle('speech:delete', ({ id }) => {
    deleteSpeechSnippet(id);
  });
  handle('speech:export', (input) => exportSpeechSnippets(input));

  handle('design:case', ({ campaignId, interviewType, interviewLanguage, force }) =>
    generateDesignCase(campaignId, interviewType ?? 'mixed', interviewLanguage ?? 'zh', force ?? false),
  );
  handle('design:submit', (input) =>
    submitDesignAnswer(
      input.campaignId,
      input.caseTitle,
      input.scenarioMd,
      input.userAnswer,
      input.interviewType,
      input.interviewLanguage,
      input.requestedType ?? input.interviewType ?? 'mixed',
    ),
  );
  handle('design:updateAnswers', (input) =>
    updateDesignCaseAnswers(
      input.campaignId,
      input.interviewType,
      input.interviewLanguage ?? 'zh',
      {
        userAnswerMd: input.userAnswerMd,
        recommendedAnswerMd: input.recommendedAnswerMd,
      },
    ),
  );
  handle('design:generateAnswer', (input) =>
    generateRecommendedAnswer(
      input.campaignId,
      input.caseTitle,
      input.scenarioMd,
      input.interviewType,
      input.interviewLanguage ?? 'zh',
      input.constraints,
    ),
  );
  handle('design:elaborate', (input) => elaborateDesignAnswer(input.selectedText, input.contextMd));

  handle('annotation:list', ({ targetType, targetId }) =>
    listAnnotations(targetType, targetId),
  );
  handle('annotation:listForCampaign', ({ campaignId }) =>
    listAnnotationsForCampaign(campaignId),
  );
  handle('annotation:listForRepo', ({ repoId }) => listCodeAnnotations(repoId));
  handle('codeRef:ensure', (input) => ({ id: ensureCodeRef(input) }));
  handle('annotation:create', (input) => createAnnotation(input));
  handle('annotation:delete', ({ id }) => {
    deleteAnnotation(id);
  });
  handle('annotation:toggleBookmark', ({ targetType, targetId }) => ({
    bookmarked: toggleBookmark(targetType, targetId),
  }));

  handle('session:list', ({ kind, nodeId, limit }) => listSessions(kind, limit, nodeId));
  handle('session:getMessages', ({ sessionId }) => getSessionMessages(sessionId));
  handle('session:getMessagesForNode', ({ nodeId }) => getNodeFollowUpMessages(nodeId));
  handle('session:search', ({ query, limit }) => searchSessions(query, limit));
  handle('session:delete', ({ sessionId }) => {
    deleteSession(sessionId);
  });
  handle('session:deleteForNode', ({ nodeId }) => {
    deleteSessionsForNode(nodeId);
  });
  handle('session:bindNode', ({ sessionId, nodeId, campaignId }) => {
    bindSessionToNode(sessionId, nodeId, campaignId);
  });

  handle('sync:status', () => getSyncStatus());
  handle('sync:beginPairing', () => beginPairing());
  handle('sync:cancelPairing', () => {
    endPairing();
  });
  handle('sync:listPeers', () =>
    listPeers().map((p) => ({
      deviceId: p.deviceId,
      displayName: p.displayName,
      platform: p.platform,
      lastSyncAt: p.lastSyncAt,
    })),
  );
  handle('sync:removePeer', ({ deviceId }) => {
    removePeer(deviceId);
  });
  handle('sync:listRuns', (input) => listSyncRuns(input?.limit ?? 20));
  handle('sync:listOverwrites', ({ runId }) => listRunOverwrites(runId));
  handle('sync:listBackups', () => listBackups());
  handle('sync:createBackup', () => {
    const info = createBackup('manual');
    pruneBackups();
    return info;
  });
  handle('sync:rollback', ({ backupFile }) => {
    restoreBackup(backupFile);
  });
  handle('sync:deleteBackup', ({ backupFile }) => {
    deleteBackup(backupFile);
  });

  handle('stt:status', () => getSttStatus());
  handle('stt:transcribe', ({ audio }) => transcribe(audio).then((text) => ({ text })));
}

export { emit, handle } from './bridge';
