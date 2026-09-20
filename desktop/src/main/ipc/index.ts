import { app, BrowserWindow, dialog } from 'electron';
import { getConfig, deleteSecret, hasSecret, setSecret, updateConfig } from '../config';
import { getCampaignOverview } from '../campaign/overview';
import { compareCampaigns } from '../campaign/compare';
import {
  createCampaign,
  createResume,
  deleteCampaign,
  deleteResume,
  duplicateResume,
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
  duplicateResumeVariant,
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
  toggleBookmark,
} from '../annotation';
import { dbHealth, getRawDb } from '../db';
import {
  declaredLlmRoles,
  findInstalledRolePack,
  getCampaignRuntime,
  getClientCapabilityView,
  listInstalledPlugins,
  setCampaignRoleProfile,
  listExternalPlugins,
} from '../plugins/runtime';
import {
  pluginStorageDelete,
  pluginStorageGet,
  pluginStorageSet,
} from '../plugins/pluginRuntimeStorage';
import {
  pluginDataCount,
  pluginDataDelete,
  pluginDataGet,
  pluginDataList,
  pluginDataSet,
} from '../plugins/pluginData';
import { permissionGateway } from '../plugins/permissionGateway';
// 远端拉取（§11.2）：比其它原语多一道 network:fetch 授权，实现在插件工作区模块里
import {
  workspaceDelete,
  workspaceFetch,
  workspaceGlob,
  workspaceGrep,
  workspaceList,
  workspaceRead,
  workspaceSnapshot,
  workspaceSymbols,
  workspaceWrite,
} from '../plugins/pluginWorkspace';
import { artifactRead } from '../plugins/pluginArtifact';
import {
  pluginLibraryAnnotate,
  pluginLibraryDeleteAnnotation,
  pluginLibraryList,
  pluginLibraryListAnnotations,
  pluginLibrarySave,
} from '../plugins/pluginLibrary';
import { completePluginJson } from '../llm/json';
import { emit } from '../ipc/bridge';
import { pluginInventoryView } from '../plugins/bootstrap';
import {
  installPluginBundle,
  installPluginFromFile,
  removeRejectedPluginDir,
  uninstallPlugin,
} from '../plugins/install';
import { downloadPluginBundle, listAvailablePlugins } from '../plugins/catalog';
import { countUnmappedPrePluginCampaigns } from '../db/backfill/pluginRuntime';
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
import { getPracticeService, listPracticeAttempts, listPracticeScores } from '../practice';
import { generateQuizAnswer, generateQuizQuestion, getQuizDraft, submitQuizAnswer, updateQuizDraft } from '../quiz';
import { clearCache, effectiveSearchPolicy, fetchUrl, search } from '../search';
import {
  deleteSpeechSnippet,
  exportSpeechSnippets,
  listSpeechSnippets,
  listSpeechSnippetsForSource,
  saveSpeechFromNode,
  saveSpeechFromQuizNode,
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
import { collectLlmRoles } from '@core/llm/roles';
import type { AppConfig } from '@core/config';
import { importResumeFromFile } from '../campaign/resumeImport';
import {
  createEvidenceService,
  extractCampaignEvidence,
  listConfirmedEvidence,
  listProposedEvidence,
} from '../evidence';
import { getStoryService } from '../story';
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
import { selectPlatformAssets } from '@core/plugins/package/contract';

function currentWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((win) => !win.isDestroyed());
}

/**
 * 落盘前剪掉角色映射里已经无效的键。
 *
 * 有效键集 = 基础角色 + 已装岗位包声明的角色。卸载某个岗位包后，它声明的角色映射就成了
 * 惰性残留（运行时读不到、设置页也不列），继续留在 config.json 里只会让同步镜像和设置页
 * 各背一份没人认领的数据。
 */
function pruneLlmRoles(config: AppConfig): AppConfig {
  const known = new Set(collectLlmRoles(declaredLlmRoles()).map((role) => role.name));
  const roles = Object.fromEntries(
    Object.entries(config.llm.roles).filter(([role]) => known.has(role)),
  );
  return { ...config, llm: { ...config.llm, roles } };
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
    const merged = updateConfig(pruneLlmRoles(next));
    applyWindowTheme(merged.ui.theme);
    return merged;
  });
  /**
   * 设置页「角色映射」的数据源：基础角色 + 已装岗位包声明的角色。
   *
   * 角色归包所有，所以没装某个包时它声明的角色不出现；对应地，已装包被卸载后
   * 残留的映射在这里落盘前被剪掉（见 pruneLlmRoles），不让它变成一条点了也改不动的僵尸行。
   */
  handle('config:listLlmRoles', () => collectLlmRoles(declaredLlmRoles()));
  handle('config:setSecret', ({ ref, value }) => setSecret(ref, value));
  handle('config:hasSecret', ({ ref }) => hasSecret(ref));
  handle('config:deleteSecret', ({ ref }) => deleteSecret(ref));

  handle('llm:testTier', ({ tier }) => testTier(tier));
  handle('llm:chat', (req) => startChat(req));
  handle('llm:cancel', ({ streamId }) => cancelStream(streamId));

  handle('search:query', (req) => search(req));
  handle('search:fetchUrl', (req) => fetchUrl(req));
  handle('search:clearCache', () => ({ removed: clearCache() }));
  handle('search:effectivePolicy', () => effectiveSearchPolicy());

  handle('db:health', () => dbHealth());

  handle('plugin:listInstalled', () => listInstalledPlugins());
  handle('plugin:inventory', () => pluginInventoryView());
  handle('plugin:getRolePack', ({ id, version }) => findInstalledRolePack(id, version));
  handle('plugin:getEntrySource', ({ id, version }) => {
    const entry = listExternalPlugins().find(
      (item) => item.package.manifest.id === id && item.package.manifest.version === version,
    );
    // 桌面端只取 desktop/ 那份实现，并剥掉平台前缀：插件拿到的键是 main.js 与 ui/**
    return selectPlatformAssets(entry?.package.codeAssets, 'desktop');
  });
  handle('pluginRuntime:storage.get', ({ pluginId, key }) => pluginStorageGet(pluginId, key));
  handle('pluginRuntime:storage.set', ({ pluginId, key, value }) => pluginStorageSet(pluginId, key, value));
  handle('pluginRuntime:storage.delete', ({ pluginId, key }) => pluginStorageDelete(pluginId, key));
  // 包声明的数据集合（阶段 3 B2）：宿主不理解值，读写都按 plugin_id 收窄；
  // 集合名必须由调用方 manifest 声明过（pluginData 内部统一判，未声明的拒）
  handle('pluginRuntime:data.get', ({ pluginId, collection, key }) =>
    pluginDataGet(pluginId, collection, key),
  );
  handle('pluginRuntime:data.put', ({ pluginId, collection, key, value }) =>
    pluginDataSet(pluginId, collection, key, value),
  );
  handle('pluginRuntime:data.delete', ({ pluginId, collection, key }) =>
    pluginDataDelete(pluginId, collection, key),
  );
  handle('pluginRuntime:data.list', ({ pluginId, collection, prefix, limit }) =>
    pluginDataList(pluginId, collection, { prefix, limit }),
  );
  handle('pluginRuntime:data.count', ({ pluginId, collection }) =>
    pluginDataCount(pluginId, collection),
  );
  handle('pluginRuntime:list', () =>
    listExternalPlugins()
      .filter((item) => item.package.manifest.main !== undefined)
      .map((item) => ({
        id: item.package.manifest.id,
        version: item.package.manifest.version,
        type: item.package.manifest.type,
        displayName: item.package.manifest.displayName,
        description: item.package.manifest.description,
        permissions: item.package.manifest.permissions,
        main: item.package.manifest.main!,
        api: item.package.manifest.api!,
        // 装上即启用、每次启动也自动启用：安装动作本身就是用户对这份权限清单的确认
        enabled: true,
        // 标记目标路由（插入点 F）：渲染层据此把包自己起的 kind 跳去承接它的本包页面。
        // 声明是可选字段，缺省时原样不出现在结果里，前端按「没有跳转」处理。
        ...(item.package.manifest.annotationTargets !== undefined
          ? { annotationTargets: [...item.package.manifest.annotationTargets] }
          : {}),
      })),
  );
  handle('pluginRuntime:llm.complete', ({ pluginId, version, system, user, role }) => {
    // 门面准入：只服务已安装且声明了 llm:complete 的代码插件
    const entry = listExternalPlugins().find(
      (item) =>
        item.package.manifest.id === pluginId &&
        item.package.manifest.version === version &&
        item.package.manifest.main !== undefined,
    );
    if (!entry?.package.manifest.permissions.includes('llm:complete')) {
      throw new Error(`插件 ${pluginId} 未声明 llm:complete 权限`);
    }
    return completePluginJson({ pluginId, version, system, user, role });
  });
  handle('pluginRuntime:evidence.listConfirmed', ({ pluginId, campaignId }) => {
    const entry = listExternalPlugins().find(
      (item) =>
        item.package.manifest.id === pluginId &&
        item.package.manifest.main !== undefined,
    );
    if (!entry?.package.manifest.permissions.includes('evidence:read-confirmed')) {
      throw new Error(`插件 ${pluginId} 未声明 evidence:read-confirmed 权限`);
    }
    return listConfirmedEvidence(getRawDb(), { campaignId });
  });
  // 工作区原语（分发计划 §11.2）：每次调用都经 permissionGateway 校验 filesystem:workspace，
  // 再由主进程实现把操作约束在本包工作区目录内（越界 / 超限在实现里抛错）
  handle('pluginRuntime:workspace.read', ({ pluginId, path, startLine, endLine }) =>
    workspaceRead(pluginId, { path, startLine, endLine }, { permissionGateway }),
  );
  handle('pluginRuntime:workspace.write', ({ pluginId, path, content }) =>
    workspaceWrite(pluginId, { path, content }, { permissionGateway }),
  );
  handle('pluginRuntime:workspace.delete', ({ pluginId, path }) =>
    workspaceDelete(pluginId, { path }, { permissionGateway }),
  );
  handle('pluginRuntime:workspace.list', ({ pluginId, path }) =>
    workspaceList(pluginId, { path }, { permissionGateway }),
  );
  handle('pluginRuntime:workspace.glob', ({ pluginId, pattern }) =>
    workspaceGlob(pluginId, { pattern }, { permissionGateway }),
  );
  handle('pluginRuntime:workspace.grep', ({ pluginId, pattern, path }) =>
    workspaceGrep(pluginId, { pattern, path }, { permissionGateway }),
  );
  handle('pluginRuntime:workspace.snapshot', ({ pluginId, path }) =>
    workspaceSnapshot(pluginId, { path }, { permissionGateway }),
  );
  // 符号提取（§11.4）：解析在宿主侧常驻的 tree-sitter 引擎里跑，包只拿结果
  handle('pluginRuntime:workspace.symbols', ({ pluginId, paths, digests }) =>
    workspaceSymbols(pluginId, { paths, digests }, { permissionGateway }),
  );
  // 远端拉取（§11.2）：固定 argv、只放行公开 https 地址，见 plugins/pluginWorkspace.ts
  handle('pluginRuntime:workspace.fetch', ({ pluginId, url, dir }) =>
    workspaceFetch(pluginId, { url, dir }, { permissionGateway }),
  );
  // artifact 原语（分发计划 §11.2）：请求里没有路径——选择器弹在主进程，
  // 渲染层拿不到也就传不了本机路径；每次调用都经 permissionGateway 校验 artifact:read
  handle('pluginRuntime:artifact.read', ({ pluginId }) =>
    artifactRead(pluginId, { permissionGateway }),
  );
  // 话术库原语（library:write）：把包页的一段文字存进用户的话术库，并按包自己起的
  // sourceKind 取回。授权来自包自己的 manifest 声明（pluginLibrary 里统一判），
  // 宿主不认识任何具体来源取值。
  handle('pluginRuntime:library.saveSnippet', ({ pluginId, text, sourceKind, sourceLabel, tier }) =>
    pluginLibrarySave(pluginId, { text, sourceKind, sourceLabel, tier }),
  );
  handle('pluginRuntime:library.listSnippets', ({ pluginId, sourceKind, limit }) =>
    pluginLibraryList(pluginId, { sourceKind, limit }),
  );
  // 标记原语（同为 library:write）：把包自己的标记写进宿主的**跨功能标记汇总**，
  // 于是包内的一条批注也会出现在宿主的标记面板里，而不是只留在包的数据集合里。
  // targetKind / targetLabel 都由包给，宿主不认识，认不出的取值按标签渲染。
  handle(
    'pluginRuntime:library.annotate',
    ({ pluginId, targetKind, targetId, targetLabel, kind, selectedText, note, color }) =>
      pluginLibraryAnnotate(pluginId, {
        targetKind,
        targetId,
        targetLabel,
        kind,
        selectedText,
        noteMd: note,
        highlightColor: color,
      }),
  );
  handle('pluginRuntime:library.listAnnotations', ({ pluginId, targetKind, limit }) =>
    pluginLibraryListAnnotations(pluginId, { targetKind, limit }),
  );
  handle('pluginRuntime:library.deleteAnnotation', ({ pluginId, id }) => {
    pluginLibraryDeleteAnnotation(pluginId, id);
  });
  handle('plugin:install', async ({ trustUnknownSigner, overwrite, confirmDataLoss }) => {
    // 弹框放在主进程：渲染层不传路径，也就没有「渲染层指定任意文件让主进程去读」这条路
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '安装插件包',
      properties: ['openFile'],
      filters: [
        { name: '插件包', extensions: ['ojb'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (canceled || filePaths.length === 0) return null;
    return installPluginFromFile(filePaths[0]!, {
      trustUnknownSigner,
      overwrite,
      confirmDataLoss,
      countPendingPrePluginCampaigns: () => countUnmappedPrePluginCampaigns(getRawDb()),
    });
  });
  handle('plugin:uninstall', ({ id, version }) => uninstallPlugin(id, version));
  // 扫描拒掉的包不在安装清单里，卸载入口够不着它，只能按目录名删
  handle('plugin:removeRejectedDir', ({ dir }) => removeRejectedPluginDir(dir));
  // 清单和更新源是同一处，用户改了更新源插件也跟着走（含镜像前缀）
  handle('plugin:listAvailable', () => listAvailablePlugins({ feedUrl: getConfig().update.feedUrl }));
  handle('plugin:installFromCatalog', async ({ id, version, trustUnknownSigner, confirmDataLoss }) => {
    const downloaded = await downloadPluginBundle({
      id,
      version,
      feedUrl: getConfig().update.feedUrl,
    });
    if (!downloaded.ok) return { ok: false as const, code: downloaded.code, detail: downloaded.detail };
    return installPluginBundle(downloaded.raw, {
      trustUnknownSigner,
      confirmDataLoss,
      countPendingPrePluginCampaigns: () => countUnmappedPrePluginCampaigns(getRawDb()),
    });
  });

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
  handle('campaign:getRuntimeDescriptor', ({ campaignId }) =>
    getCampaignRuntime(getRawDb(), campaignId),
  );
  handle('campaign:setRoleProfile', (input) => {
    const view = setCampaignRoleProfile(getRawDb(), input);
    // 代码插件事件（§7.9）：能力启停变化
    emit('campaign:capability-changed', { campaignId: input.campaignId });
    return view;
  });
  handle('campaign:getClientCapabilityView', (input) =>
    getClientCapabilityView(getRawDb(), input),
  );

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
  // 复制一份：正文/模板/寸照原样保留，不走模型重排，打开即用
  handle('resume:duplicate', ({ id }) => duplicateResume(id));
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
  // 复制一份优化版：内容/模板/寸照与来源关系原样保留
  handle('resumeVariant:duplicate', ({ id }) => duplicateResumeVariant(id));

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

  handle('quiz:draft', ({ nodeId }) => getQuizDraft(nodeId));
  handle('quiz:updateDraft', (input) => updateQuizDraft(input));
  handle('quiz:question', ({ nodeId }) => generateQuizQuestion(nodeId));
  handle('quiz:answer', ({ nodeId, question }) => generateQuizAnswer(nodeId, question));
  handle('quiz:submit', (input) => submitQuizAnswer(input.nodeId, input.question, input.userAnswer));

  handle('practice:createSession', (input) => getPracticeService().createSession(input));
  handle('practice:getSession', ({ sessionId }) => getPracticeService().getSession(sessionId));
  handle('practice:nextTurn', (input) => getPracticeService().nextTurn(input));
  handle('practice:evaluate', async (input) => {
    const result = await getPracticeService().evaluate(input);
    // 代码插件事件（§7.9）：一次练习评分完成
    emit('practice:completed', {
      campaignId: result.campaignId,
      formatId: result.formatId,
      totalScore: result.totalScore,
    });
    return result;
  });
  handle('practice:listAttempts', (query) => listPracticeAttempts(query));
  handle('practice:listScores', ({ attemptId }) => listPracticeScores(attemptId));

  handle('speech:saveFromNode', (input) =>
    saveSpeechFromNode(input.nodeId, input.contentMd, input.tier),
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

  handle('annotation:list', ({ targetType, targetId }) =>
    listAnnotations(targetType, targetId),
  );
  handle('annotation:listForCampaign', ({ campaignId }) =>
    listAnnotationsForCampaign(campaignId),
  );
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

  handle('evidence:extract', ({ campaignId }) => extractCampaignEvidence(getRawDb(), campaignId));
  handle('evidence:listConfirmed', (scope) => listConfirmedEvidence(getRawDb(), scope));
  handle('evidence:listProposed', (scope) => listProposedEvidence(getRawDb(), scope));
  handle('evidence:propose', (input) => createEvidenceService(getRawDb()).propose(input));
  handle('evidence:confirm', ({ id }) => createEvidenceService(getRawDb()).confirm(id));
  handle('evidence:reject', ({ id }) => createEvidenceService(getRawDb()).reject(id));

  handle('story:list', ({ campaignId }) => getStoryService().list(campaignId));
  handle('story:get', ({ id }) => getStoryService().get(id));
  handle('story:create', (input) => getStoryService().create(input));
  handle('story:revise', ({ id, patch }) => getStoryService().revise(id, patch));
  handle('story:delete', ({ id }) => {
    getStoryService().remove(id);
  });
  handle('story:createDelivery', ({ id, duration }) =>
    getStoryService().createDelivery(id, duration),
  );
  handle('story:listDeliveries', ({ id }) => getStoryService().listDeliveries(id));
}

export { emit, handle } from './bridge';
