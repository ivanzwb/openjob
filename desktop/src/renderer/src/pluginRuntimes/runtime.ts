/**
 * 代码插件激活（§7.9）：渲染进程内加载入口（Obsidian 同构），API 走 IPC 桥。
 *
 * 加载机制：入口源码经 `plugin:getEntrySource` 取回（主进程已做过安装期隔离
 * 扫描），在函数体内以 CommonJS 形式执行——`require('openjob')` 是插件拿到
 * 宿主能力的唯一途径。插件代码运行在渲染层的页面沙箱里，没有 Node 能力。
 */
import { useEffect, useState } from 'react';
import {
  activatePluginRuntime,
  createEventHub,
  type ActivePluginRuntime,
  type PluginRuntimeModule,
  type PluginRuntimeServices,
  type PluginWorkspaceService,
  type PluginArtifactService,
  type PluginLibraryService,
} from '@core/plugins/pluginRuntime/host';
import type { LlmRole } from '@core/enums';
import { invoke } from '../ipc';

const hub = createEventHub();
let active: ActivePluginRuntime[] = [];
const uiAssetsByPlugin = new Map<string, Record<string, string>>();
const listeners = new Set<() => void>();

/**
 * 包声明的标记目标路由（manifest.annotationTargets，插入点 F）：kind → 承接页面。
 *
 * 宿主不认识包自己起的 kind，只按这份声明决定「标记汇总里的这一行能不能跳、跳到哪个页面」。
 * 只装已启用的包；解析时还会再核对「这个页面确实在本端激活了」，未激活即退回信息行。
 */
const annotationTargetsByPlugin = new Map<
  string,
  ReadonlyArray<{ kind: string; label: string; pageId: string }>
>();

/** 打开插件页面的请求（由标记汇总触发，App 订阅后切页签）：值是该页面的宿主完整 id */
const pageOpenListeners = new Set<(fullId: string) => void>();

/**
 * 最近一次「跳去包页面看某个标记目标」的意图。页面可能还没挂载（页签刚被切过去），
 * 这时事件路径上的 iframe 订阅还不存在——WebView 挂载时取一次这条待办，才不会丢。
 */
let pendingAnnotationOpen: { pluginId: string; pageId: string; kind: string; targetId: string } | null =
  null;

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * 解析一条**包自己起的**标记目标该跳到哪：返回宿主侧完整页面 id，找不到则 null（信息行）。
 * 命中条件三件套：包已激活、声明了该 kind、且声明的 pageId 真的在本端注册了。
 */
export function resolveAnnotationTarget(
  kind: string,
): { pluginId: string; pageId: string; fullId: string } | null {
  for (const runtime of active) {
    const declared = annotationTargetsByPlugin.get(runtime.pluginId) ?? [];
    const match = declared.find((entry) => entry.kind === kind);
    if (!match) continue;
    const page = runtime.pages.find((candidate) => candidate.id === match.pageId);
    if (!page) continue;
    return { pluginId: runtime.pluginId, pageId: match.pageId, fullId: page.fullId };
  }
  return null;
}

/** App 订阅它来切到插件页面页签（并把页签挂载起来）。 */
export function onOpenPluginPage(listener: (fullId: string) => void): () => void {
  pageOpenListeners.add(listener);
  return () => pageOpenListeners.delete(listener);
}

/**
 * 从宿主标记汇总跳去承接页面：切到该页签，并把 `{ kind, targetId }` 经宿主→页面事件交过去。
 * 页面尚未挂载时事件到不了，意图落进待办，由 WebView 挂载时补投。
 */
export function requestAnnotationOpen(intent: {
  pluginId: string;
  pageId: string;
  kind: string;
  targetId: string;
}): void {
  pendingAnnotationOpen = intent;
  const fullId = `${intent.pluginId}:${intent.pageId}`;
  for (const listener of pageOpenListeners) listener(fullId);
  // 已经挂载的页面走实时事件：与宿主其它 openjobEvent 同一条宿主→页面通路
  hub.emit('annotation:open', {
    pluginId: intent.pluginId,
    kind: intent.kind,
    targetId: intent.targetId,
  });
}

/** WebView 挂载时取一次待办（同一包的），取到即清空，避免重复投递。 */
export function takePendingAnnotationOpen(
  pluginId: string,
): { kind: string; targetId: string } | null {
  if (!pendingAnnotationOpen || pendingAnnotationOpen.pluginId !== pluginId) return null;
  const { kind, targetId } = pendingAnnotationOpen;
  pendingAnnotationOpen = null;
  return { kind, targetId };
}

export function subscribePluginRuntimes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getActivePluginRuntimes(): ActivePluginRuntime[] {
  return active;
}

export function getUiAssets(pluginId: string): Record<string, string> {
  return uiAssetsByPlugin.get(pluginId) ?? {};
}

/**
 * 工作区原语的门面（§11.2）：包侧只拿相对路径，越界与上限判定全在主进程。
 * 每次调用都是一条 IPC，主进程的网关逐次校验 `filesystem:workspace`。
 */
function workspaceService(pluginId: string): PluginWorkspaceService {
  return {
    read: (path, options) =>
      invoke('pluginRuntime:workspace.read', { pluginId, path, ...(options ?? {}) }),
    write: (path, content) => invoke('pluginRuntime:workspace.write', { pluginId, path, content }),
    delete: (path) => invoke('pluginRuntime:workspace.delete', { pluginId, path }),
    list: (path = '.') => invoke('pluginRuntime:workspace.list', { pluginId, path }),
    glob: (pattern) => invoke('pluginRuntime:workspace.glob', { pluginId, pattern }),
    grep: (pattern, options) =>
      invoke('pluginRuntime:workspace.grep', { pluginId, pattern, path: options?.path }),
    snapshot: (path) => invoke('pluginRuntime:workspace.snapshot', { pluginId, path }),
    symbols: (paths, options) =>
      invoke('pluginRuntime:workspace.symbols', { pluginId, paths, ...(options ?? {}) }),
    fetch: (input) =>
      invoke('pluginRuntime:workspace.fetch', { pluginId, url: input.url, dir: input.dir }),
  };
}

/**
 * artifact 原语的门面（§11.2）：请求里**没有路径**——由主进程弹选择器、读用户选中的文件。
 * 每次调用都是一条 IPC，主进程的网关逐次校验 `artifact:read`，没有用户选择就拒。
 */
function artifactService(pluginId: string): PluginArtifactService {
  return {
    read: () => invoke('pluginRuntime:artifact.read', { pluginId }),
  };
}

/**
 * 话术库与标记原语的门面（§11.2 通用原语）：包把一段文字按自己起的来源类型存进用户的话术库，
 * 再按同一来源类型取回自己存过的那几条；标记同理，写进宿主的跨功能标记汇总。每次调用都是
 * 一条 IPC，主进程的网关逐次校验 `library:write`（声明即上限）。
 */
function libraryService(pluginId: string): PluginLibraryService {
  return {
    saveSnippet: (request) =>
      invoke('pluginRuntime:library.saveSnippet', { pluginId, ...request }),
    listSnippets: (query) =>
      invoke('pluginRuntime:library.listSnippets', { pluginId, ...(query ?? {}) }),
    // 通道的字段名与门面略有差异（note / color）：这里逐项对应，别把 noteMd / highlightColor
    // 原样透传成通道上不认识的字段
    annotate: (request) =>
      invoke('pluginRuntime:library.annotate', {
        pluginId,
        targetKind: request.targetKind,
        targetId: request.targetId,
        kind: request.kind,
        ...(request.targetLabel !== undefined ? { targetLabel: request.targetLabel } : {}),
        ...(request.selectedText !== undefined ? { selectedText: request.selectedText } : {}),
        ...(request.noteMd !== undefined ? { note: request.noteMd } : {}),
        ...(request.highlightColor !== undefined ? { color: request.highlightColor } : {}),
      }),
    listAnnotations: (query) =>
      invoke('pluginRuntime:library.listAnnotations', { pluginId, ...(query ?? {}) }),
    deleteAnnotation: (id) => invoke('pluginRuntime:library.deleteAnnotation', { pluginId, id }),
  };
}

/**
 * 数据集合门面（阶段 3 B2）：集合名与键原样交给主进程，值一律是字符串，序列化由包自己做。
 * 每次调用都是一条 IPC，主进程按包自己的 manifest 声明判是否放行——未声明的集合拒。
 */
function dataService(pluginId: string): PluginRuntimeServices['data'] {
  return {
    get: (collection, key) => invoke('pluginRuntime:data.get', { pluginId, collection, key }),
    put: (collection, key, value) =>
      invoke('pluginRuntime:data.put', { pluginId, collection, key, value }),
    delete: (collection, key) =>
      invoke('pluginRuntime:data.delete', { pluginId, collection, key }),
    list: (collection, options) =>
      invoke('pluginRuntime:data.list', { pluginId, collection, ...(options ?? {}) }),
    count: (collection) => invoke('pluginRuntime:data.count', { pluginId, collection }),
  };
}

/** CommonJS 装配：`require('openjob')` 是插件拿到宿主门面的唯一入口 */
function loadModule(
  source: string,
  pluginId: string,
  version: string,
  permissions: readonly string[],
): PluginRuntimeModule {
  const module = { exports: {} as Partial<PluginRuntimeModule> };
  // 权限即 API 面：未声明的命名空间不注入（§7.9）
  const facade: Record<string, unknown> = {
    storage: {
      get: (key: string) => invoke('pluginRuntime:storage.get', { pluginId, key }),
      set: (key: string, value: string) => invoke('pluginRuntime:storage.set', { pluginId, key, value }),
      delete: (key: string) => invoke('pluginRuntime:storage.delete', { pluginId, key }),
    },
    // 数据集合：值为字符串，集合是否可用由包自己的 manifest 声明决定
    data: {
      get: (collection: string, key: string) =>
        invoke('pluginRuntime:data.get', { pluginId, collection, key }),
      put: (collection: string, key: string, value: string) =>
        invoke('pluginRuntime:data.put', { pluginId, collection, key, value }),
      delete: (collection: string, key: string) =>
        invoke('pluginRuntime:data.delete', { pluginId, collection, key }),
      list: (collection: string, options?: { prefix?: string; limit?: number }) =>
        invoke('pluginRuntime:data.list', { pluginId, collection, ...(options ?? {}) }),
      count: (collection: string) =>
        invoke('pluginRuntime:data.count', { pluginId, collection }),
    },
    campaign: {
      getDescriptor: async (campaignId: string) =>
        (await invoke('campaign:getRuntimeDescriptor', { campaignId }))?.descriptor ?? null,
    },
  };
  if (permissions.includes('llm:complete')) {
    facade.llm = {
      complete: (request: { system: string; user: string; role?: LlmRole }) =>
        invoke('pluginRuntime:llm.complete', {
          pluginId,
          version,
          ...request,
        }),
    };
    // 基础流式问答：宿主 Agent 编排（工具/检索/流式），领域问答由插件组合实现
    facade.agent = {
      ask: (request: {
        question: string;
        role?: LlmRole;
        allowTools?: boolean;
        campaignId?: string;
      }) =>
        invoke('llm:chat', {
          // 不给默认角色：角色名归岗位包所有，渲染层不认识任何具体角色，缺省落 main 档
          ...(request.role !== undefined ? { role: request.role } : {}),
          messages: [{ role: 'user', content: request.question }],
          allowTools: request.allowTools ?? false,
          allowWebSearch: false,
          ...(request.campaignId !== undefined ? { campaignId: request.campaignId } : {}),
        }),
    };
  }
  if (permissions.includes('evidence:read-confirmed')) {
    facade.evidence = {
      listConfirmed: (campaignId: string) =>
        invoke('pluginRuntime:evidence.listConfirmed', { pluginId, campaignId }),
    };
  }
  // 权限即 API 面：未声明 filesystem:workspace 时门面上没有 workspace
  if (permissions.includes('filesystem:workspace')) {
    facade.workspace = workspaceService(pluginId);
  }
  // 话术库：未声明 library:write 时门面上没有 library
  if (permissions.includes('library:write')) {
    facade.library = libraryService(pluginId);
  }
  const requireShim = (id: string): unknown => {
    if (id === 'openjob') return facade;
    throw new Error(`插件只允许 require('openjob')，实际请求了 ${id}`);
  };
  new Function('module', 'exports', 'require', source)(module, module.exports, requireShim);
  const loaded = module.exports as PluginRuntimeModule;
  if (typeof loaded?.activate !== 'function') {
    throw new Error(`插件 ${pluginId} 的入口缺少 activate(ctx)`);
  }
  return loaded;
}

/** 激活全部「已确认启用」的代码插件；单个失败不阻断其余（错误进 console 供诊断） */
export async function activateInstalledPluginRuntimes(): Promise<void> {
  let pluginRuntimes: Awaited<ReturnType<typeof invoke<'pluginRuntime:list'>>>;
  try {
    pluginRuntimes = await invoke('pluginRuntime:list', undefined);
  } catch (error) {
    // 连清单都拿不到时不能静默返回：表现是「所有插件页签凭空消失」，而这与
    // 「一个代码插件都没装」在界面上完全一样，没有日志就无从分辨
    console.error('[pluginRuntime] 读取插件清单失败，本次不激活任何插件页', error);
    return;
  }
  const next: ActivePluginRuntime[] = [];

  // 标记目标路由每次重激活都重算：停用的包随这次的清单消失，未声明该字段的包原样不在表里
  annotationTargetsByPlugin.clear();

  for (const plugin of pluginRuntimes.filter((item) => item.enabled)) {
    if (plugin.annotationTargets !== undefined) {
      annotationTargetsByPlugin.set(plugin.id, plugin.annotationTargets);
    }
    try {
      const entry = await invoke('plugin:getEntrySource', {
        id: plugin.id,
        version: plugin.version,
      });
      if (!entry) continue;
      uiAssetsByPlugin.set(plugin.id, entry.uiAssets);
      // 激活时把「拿到哪一份清单」打出来：桥被拒时对照这一行，一眼能看出是清单陈旧还是页面越界
      console.info(
        `[pluginRuntime] 激活 ${plugin.id}@${plugin.version}，已声明：${plugin.permissions.join('、') || '（空）'}`,
      );
      next.push(
        activatePluginRuntime({
          pluginId: plugin.id,
          version: plugin.version,
          // 声明的权限必须原样传进激活：它决定暴露给页面的桥方法，
          // 漏传的表现不是「少几个方法」，而是页面调用任何带权限的原语都被判成「未声明」
          permissions: plugin.permissions,
          module: loadModule(entry.source, plugin.id, plugin.version, plugin.permissions),
          services: {
            campaign: {
              getDescriptor: async (campaignId) =>
                (await invoke('campaign:getRuntimeDescriptor', { campaignId }))?.descriptor ?? null,
            },
            storage: {
              get: (key) => invoke('pluginRuntime:storage.get', { pluginId: plugin.id, key }),
              set: (key, value) =>
                invoke('pluginRuntime:storage.set', { pluginId: plugin.id, key, value }),
              delete: (key) => invoke('pluginRuntime:storage.delete', { pluginId: plugin.id, key }),
            },
            // 数据集合：人人可用，读写哪些集合由包自己的 manifest 声明决定
            data: dataService(plugin.id),
            // 工作区原语；未声明 filesystem:workspace 时为 undefined（ctx.workspace 不存在）
            workspace: plugin.permissions.includes('filesystem:workspace')
              ? workspaceService(plugin.id)
              : undefined,
            // artifact 原语；未声明 artifact:read 时为 undefined（ctx.artifact 不存在）
            artifact: plugin.permissions.includes('artifact:read')
              ? artifactService(plugin.id)
              : undefined,
            // 话术库原语；未声明 library:write 时为 undefined（ctx.library 不存在）
            library: plugin.permissions.includes('library:write')
              ? libraryService(plugin.id)
              : undefined,
          },
          hub,
        }),
      );
    } catch (error) {
      console.error(`[pluginRuntime] 激活失败：${plugin.id}@${plugin.version}`, error);
    }
  }

  // 重新激活 = 全量替换：撤掉旧集合里不在新集合中的插件
  const nextIds = new Set(next.map((item) => item.pluginId));
  for (const previous of active) {
    if (!nextIds.has(previous.pluginId)) previous.deactivate();
  }
  active = next;
  notify();
}

/** React 订阅：代码插件页签 */
export function usePluginRuntimeTabs(): ActivePluginRuntime[] {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion((v) => v + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return active;
}

export function useActivateOnMount(): void {
  useEffect(() => {
    void activateInstalledPluginRuntimes();
  }, []);
}

/** 宿主侧订阅插件事件（把主进程桥接事件转发进 hub 时使用） */
export function onPluginEvent(
  event: Parameters<typeof hub.subscribe>[0],
  handler: (payload: unknown) => void,
): () => void {
  const subscription = hub.subscribe(event, '__host__', handler);
  return () => {
    subscription.dispose();
  };
}

export { hub as pluginRuntimeEventHub };

/** 启用：主进程落确认记录后，立即重新激活让页签即时出现 */
export async function enablePluginRuntime(id: string): Promise<void> {
  await invoke('pluginRuntime:setEnabled', { id, enabled: true });
  await activateInstalledPluginRuntimes();
}

/** 停用：撤贡献断桥，页签即时消失；确认记录保留（再次启用不再重复确认） */
export async function disablePluginRuntime(id: string): Promise<void> {
  await invoke('pluginRuntime:setEnabled', { id, enabled: false });
  await activateInstalledPluginRuntimes();
}
