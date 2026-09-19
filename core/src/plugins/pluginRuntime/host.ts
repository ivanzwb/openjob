/**
 * 代码插件激活宿主（§7.9）：生命周期、注册表与命名空间规则。
 *
 * 这一层是纯逻辑——「代码怎么被加载成模块」由各端注入（桌面渲染层用 CommonJS
 * 函数包装，测试里直接给对象），「门面背后的服务」由传输层注入（渲染层走 IPC
 * 桥，移动端走 WebView 桥）。本模块只管三件事：
 *
 * 1. 命名空间：插件注册的视图/命令 id 一律 `<pluginId>:<name>`，跨插件不冲突，
 *    宿主与声明式入口共用同一个能力页签槽位；
 * 2. 生命周期：activate 顺序 = 激活请求顺序，deactivate 幂等且撤干净所有贡献；
 * 3. 事件白名单：插件只能订阅宿主显式开放的事件，不能造通道。
 */

import type { ExplanationTier, LlmRole } from '../../enums';
import type { CampaignRuntimeDescriptor } from '../types';
import { assertPluginBridgeMethod } from './bridge';

export type PluginRuntimeEventName =
  | 'campaign:attached'
  | 'campaign:capability-changed'
  | 'practice:completed'
  // 宿主把标记汇总里的一条**包自己起的**目标交给承接它的页面：payload 是 { kind, targetId }。
  // 角色中立：宿主不认识 kind，只按 manifest.annotationTargets 找到 pageId 再原样转达。
  | 'annotation:open';

export const PLUGIN_RUNTIME_EVENTS: readonly PluginRuntimeEventName[] = [
  'campaign:attached',
  'campaign:capability-changed',
  'practice:completed',
  'annotation:open',
];

/** 插件注册的 Webview 页面：资源路径相对包根，渲染进 Webview 沙箱 */
export interface PluginRuntimePage {
  /** 插件内唯一；宿主侧完整 id 为 `<pluginId>:<id>` */
  id: string;
  title: string;
  /** 包内 Webview 资源路径，例如 ui/index.html */
  webviewPath: string;
}

export interface RegisteredPluginRuntimePage extends PluginRuntimePage {
  pluginId: string;
  /** 宿主侧完整 id：`<pluginId>:<id>` */
  fullId: string;
}

export type CommandHandler = (args: unknown) => Promise<unknown> | unknown;

/** 工作区目录项；`path` 是相对本包工作区根的 POSIX 路径。 */
export interface WorkspaceEntry {
  path: string;
  type: 'file' | 'dir';
  /** 目录为 null */
  size: number | null;
}

/** grep 命中：相对路径 + 1 起行号 + 命中行文本。 */
export interface WorkspaceGrepMatch {
  path: string;
  line: number;
  text: string;
}

/** 文本快照：整文件内容 + 摘要，供包侧做差量与引用。 */
export interface WorkspaceSnapshot {
  path: string;
  sha256: string;
  bytes: number;
  text: string;
}

/**
 * 符号 kind 的**闭集合**：`workspace.symbols` 只产出这些值（tree-sitter 引擎按语言节点类型
 * 映射到这张表，映射表在 `desktop/src/main/symbols/treeSitter.ts`）。
 */
export const WORKSPACE_SYMBOL_KINDS = [
  'fn',
  'method',
  'class',
  'object',
  'module',
  'interface',
  'trait',
  'impl',
  'struct',
  'enum',
  'type',
] as const;

export type WorkspaceSymbolKind = (typeof WORKSPACE_SYMBOL_KINDS)[number];

/** 一个符号命中。行号一律 1 起，且是**文件内**行号（相对本包工作区根，不含绝对路径）。 */
export interface WorkspaceSymbol {
  name: string;
  kind: WorkspaceSymbolKind;
  line: number;
  /** 声明结束行；与 line 相同表示单行声明 */
  endLine: number;
  /** 外层符号名链，从最外层到直接父级；顶层符号为空数组 */
  containerPath: string[];
}

/** 单文件的符号提取结果。读不出来与解析不了是两回事，分别在 sha256 / language 上表达。 */
export interface WorkspaceSymbolsFile {
  path: string;
  /** 文件内容摘要；文件不在或读不动时为 null */
  sha256: string | null;
  bytes: number;
  /** 命中的语法名；没有对应语法（扩展名不认识）时为 null——**不是错误** */
  language: string | null;
  /** 传了 digests 且内容与上次一致：符号不再重算，symbols 为空 */
  unchanged: boolean;
  /** 没解析的原因：文件太大 / 文件不在 */
  skipped: 'too-large' | 'not-found' | null;
  symbols: WorkspaceSymbol[];
}

/**
 * 批量符号提取的结果。
 *
 * `truncated` 为 true 表示中途撞到预算（总字节 / 时间 / 结果条数）收了工，`files` 是**已完成
 * 的那部分**——包侧据此收窄路径重来一次，而不是把这次当成完整结果。
 */
export interface WorkspaceSymbolsResult {
  files: WorkspaceSymbolsFile[];
  truncated: boolean;
}

/** 一次从远端拉取的结果（`workspace.fetch`）。 */
export interface WorkspaceFetchResult {
  /** 相对本包工作区的目标目录 */
  dir: string;
  /** 这次是新建检出还是就地更新 */
  mode: 'clone' | 'update';
  /** 拉到的提交 */
  commit: string;
  /** 当前分支；detached 时为 null */
  branch: string | null;
  bytes: number;
  fileCount: number;
}

/**
 * 工作区原语（分发计划 §11.2）：本包工作区内的读 / 写 / 删 / 遍历 / glob / grep / 文本快照。
 *
 * 语义边界写死在这里，实现（主进程）必须照做：
 * - 路径一律相对本包工作区根；解析后越出（绝对路径、`..` 逸出、符号链接逸出）即拒；
 * - 只做文本与字节，**不执行、不解压、不建符号链接**；
 * - 单次读 / 单次写 / glob 结果数 / grep 命中数都有上限，超限报错而不是静默截断。
 */
export interface PluginWorkspaceService {
  read(path: string, options?: { startLine?: number; endLine?: number }): Promise<string>;
  write(path: string, content: string): Promise<void>;
  delete(path: string): Promise<void>;
  list(path?: string): Promise<WorkspaceEntry[]>;
  glob(pattern: string): Promise<string[]>;
  grep(pattern: string, options?: { path?: string }): Promise<WorkspaceGrepMatch[]>;
  snapshot(path: string): Promise<WorkspaceSnapshot | null>;
  /**
   * 批量符号提取（§11.4）：一次给一批**工作区内**的相对路径，拿回每文件的符号与摘要。
   *
   * 解析由宿主侧常驻的 tree-sitter 引擎做，包沙箱里不跑解析器；传 `digests` 可做增量——
   * 摘要没变的文件只回摘要与 unchanged。超预算时返回已完成部分并带 `truncated`。
   */
  symbols(
    paths: string[],
    options?: { digests?: Record<string, string> },
  ): Promise<WorkspaceSymbolsResult>;
  /**
   * 从远端 git 仓库拉取到本包工作区（§11.2 工作区原语的最后一行）。
   *
   * 需要 `network:fetch` **与** `filesystem:workspace` 两项声明：前者是网络出口，后者是落盘，
   * 缺任何一项都在碰文件系统之前拒。只接受公开的 https 地址（不带凭据、不指向本机/内网），
   * 固定深度 1、无 submodule、无 LFS，体积与文件数有上限。
   *
   * 目标目录已存在时：是检出就**更新到最新**（相当于 fetch + 硬重置，**丢弃该目录里的本地改动**
   * ——那是包的临时检出，不是用户的工作副本）；非空又不是检出就拒，不覆盖包自己的数据。
   */
  fetch(input: { url: string; dir?: string }): Promise<WorkspaceFetchResult>;
}

/**
 * 一条存进**用户话术库**的片段（`library` 命名空间）。
 *
 * 话术库是宿主拥有的用户面（`speech_snippet`）：包只往里存、只按自己起的 `sourceKind`
 * 取回自己存过的那几条，宿主不理解岗位语义。`label` 是包自己算出的可读来源
 * （如 file:line），存进宿主既有的来源标签机制，包据此显示「已存入话术库」并列表。
 */
export interface LibrarySnippet {
  id: string;
  /** 正文（包自己给的纯文本 / markdown） */
  text: string;
  /** 人类可读的来源标签（包自己算，如 `src/foo.ts:12`） */
  label: string;
  createdAt: number;
}

/**
 * 一条写进宿主**跨功能标记汇总**的标记（`library` 命名空间）。
 *
 * 与话术库同一条思路：`targetKind`（目标类型）由包自己起一个自由字符串，宿主不认识，
 * 原样写进 `annotation.target_type`（一列裸 text）；`targetLabel` 是包自己算的可读标签，
 * 存进 `target_label`。宿主认识的取值（node / explanation / question / intel）不受影响，
 * 认不出的取值就按存下来的标签渲染，没有标签则退回原始取值。
 */
export interface LibraryAnnotation {
  id: string;
  /** 包自己起的目标类型（如 `code-mark`），宿主不认识 */
  targetKind: string;
  /** 目标 id：包自己保证在同一个 targetKind 下稳定（如 `路径:起-止`） */
  targetId: string;
  /** 人类可读的目标标签（如 `src/foo.ts:12-40`）；缺省时宿主退回 targetId */
  targetLabel: string;
  /** 标记类型：宿主认识的 highlight / note / elaboration / bookmark 照旧，包也可以给别的 */
  kind: string;
  selectedText: string | null;
  noteMd: string | null;
  highlightColor: string | null;
  createdAt: number;
}

/**
 * 话术库与标记原语（`library` 命名空间）：两件事共用一份授权（`library:write`）。
 *
 * 语义边界：宿主把包自起的取值原样写进裸 text 列，读取侧对认不出的取值走标签兜底；
 * 宿主不解释这些值，也不为某个岗位开专用字段。「声明即授权」：只有 manifest 里声明过
 * `library:write` 的包才能存/取，宿主不认识任何具体取值。
 */
export interface PluginLibraryService {
  saveSnippet(request: {
    text: string;
    /** 包自己起的来源类型（如 `code-ref`），宿主不认识 */
    sourceKind: string;
    /** 包自己算的可读来源标签（如 file:line） */
    sourceLabel: string;
    tier?: ExplanationTier;
  }): Promise<LibrarySnippet>;
  listSnippets(query?: { sourceKind?: string; limit?: number }): Promise<LibrarySnippet[]>;
  /**
   * 写一条标记进宿主的**跨功能标记汇总**（annotation 表），让包自己的标记也能出现在
   * 宿主的标记面板里。`targetKind` 与 `targetLabel` 都由包给，宿主不认识。
   */
  annotate(request: {
    targetKind: string;
    targetId: string;
    targetLabel?: string;
    kind: string;
    selectedText?: string;
    noteMd?: string;
    highlightColor?: string;
  }): Promise<LibraryAnnotation>;
  /** 取回标记；传 `targetKind` 只取包自己这一类，不传取全部。按时间倒序。 */
  listAnnotations(query?: { targetKind?: string; limit?: number }): Promise<LibraryAnnotation[]>;
  deleteAnnotation(id: string): Promise<void>;
}

/** 用户显式提供的文件读入结果（§11.2 artifact 原语）：对包是只读数据。 */
export interface PluginArtifact {
  /** 用户选中的文件名（basename）；刻意不带本机目录，避免把路径泄进沙箱 */
  name: string;
  /** 来源格式：分隔文本按扩展名粗判为 `delimited`，其余为 `text` */
  format: 'text' | 'delimited';
  /** 原始 utf8 文本 */
  text: string;
  bytes: number;
  sha256: string;
  /**
   * 行 × 单元格：文本每行一个单元格；分隔文件按分隔符做一次朴素拆分。
   * **不做引号处理**——那是 artifact 解析器的职责，原语只负责「读进来」。
   */
  rows: string[][];
}

/**
 * artifact 原语（分发计划 §11.2）：读入**用户显式选择**的文件（表格 / 文档）。
 *
 * 与工作区原语的本质区别：这里**不接收路径**。包只能发起一次「请用户选个文件」的请求，
 * 由宿主弹选择器、读用户选中的那一个；没有用户选择就没有内容。读进来的数据对包只读，
 * 也不落进本包工作区（除非包自己再写）。
 */
export interface PluginArtifactService {
  read(): Promise<PluginArtifact>;
}

export interface PluginRuntimeServices {
  /** 只读指定 Campaign 的 descriptor；无 descriptor 时为 null */
  readonly campaign: {
    readonly getDescriptor: (campaignId: string) => Promise<CampaignRuntimeDescriptor | null>;
  };
  /** 插件私有 KV，与主库物理隔离 */
  readonly storage: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
  /**
   * 包声明的数据集合：宿主建通用承载表，内容对宿主不透明。
   *
   * 值一律是字符串（与 storage 同一份契约），包自己序列化与反序列化；集合名必须是本包
   * manifest 声明过的，否则调用被拒。
   */
  readonly data: {
    get(collection: string, key: string): Promise<string | null>;
    put(collection: string, key: string, value: string): Promise<void>;
    delete(collection: string, key: string): Promise<void>;
    list(
      collection: string,
      options?: { prefix?: string; limit?: number },
    ): Promise<Array<{ key: string; value: string }>>;
    count(collection: string): Promise<number>;
  };
  /** 受控 LLM 补全（同网关同审计）；仅 manifest 声明 llm:complete 时注入 */
  readonly llm?: {
    complete(request: {
      system: string;
      user: string;
      role?: LlmRole;
    }): Promise<unknown>;
  };
  /**
   * 基础流式问答（Agent 编排 + 工具 + 流式增量）。领域问答（如源码问答）
   * 由插件用「本能力 + 自己的上下文」实现，宿主不为单个领域单开通道。
   * 仅 manifest 声明 llm:complete 时注入；增量经宿主事件流推送。
   */
  readonly agent?: {
    ask(request: {
      question: string;
      role?: LlmRole;
      allowTools?: boolean;
      campaignId?: string;
    }): Promise<{ streamId: string; sessionId: string | null }>;
  };
  /** 只读已确认证据；仅 manifest 声明 evidence:read-confirmed 时注入 */
  readonly evidence?: {
    listConfirmed(campaignId: string): Promise<unknown>;
  };
  /** 本包工作区原语；仅 manifest 声明 filesystem:workspace 时注入 */
  readonly workspace?: PluginWorkspaceService;
  /** artifact 原语（用户显式提供的文件读入）；仅 manifest 声明 artifact:read 时注入 */
  readonly artifact?: PluginArtifactService;
  /** 话术库原语（写入用户的话术库）；仅 manifest 声明 library:write 时注入 */
  readonly library?: PluginLibraryService;
}

export interface PluginRuntimeContext {
  readonly pluginId: string;
  /** 只读指定 Campaign 的 descriptor；无 descriptor 时为 null */
  readonly campaign: PluginRuntimeServices['campaign'];
  /** 插件私有 KV */
  readonly storage: PluginRuntimeServices['storage'];
  /** 包声明的数据集合（内容对宿主不透明） */
  readonly data: PluginRuntimeServices['data'];
  /** 受控 LLM 补全；未声明 llm:complete 权限时为 undefined */
  readonly llm: PluginRuntimeServices['llm'];
  /** 基础流式问答；未声明 llm:complete 权限时为 undefined */
  readonly agent: PluginRuntimeServices['agent'];
  /** 只读已确认证据；未声明 evidence:read-confirmed 权限时为 undefined */
  readonly evidence: PluginRuntimeServices['evidence'];
  /** 工作区原语；未声明 filesystem:workspace 权限时为 undefined */
  readonly workspace: PluginRuntimeServices['workspace'];
  /** artifact 原语；未声明 artifact:read 权限时为 undefined */
  readonly artifact: PluginRuntimeServices['artifact'];
  /** 话术库原语；未声明 library:write 权限时为 undefined */
  readonly library: PluginRuntimeServices['library'];
  views: {
    registerPage(page: PluginRuntimePage): { dispose(): void };
  };
  commands: {
    register(id: string, handler: CommandHandler): { dispose(): void };
  };
  events: {
    on(event: PluginRuntimeEventName, handler: (payload: unknown) => void): { dispose(): void };
  };
  /**
   * 桥自注册（§11.2 / §6 判据三）：包声明自己要用的桥方法（命名空间 + 方法名），
   * 宿主按声明放行——未声明的桥方法页面够不到（默认拒绝）。声明无权限门槛，
   * 但「声明 ≠ 有权限」：真正放行仍要过权限网关。
   */
  bridge: {
    declare(name: string): { dispose(): void };
    methods(): readonly string[];
  };
}

export interface PluginRuntimeModule {
  activate(ctx: PluginRuntimeContext): void | (() => void);
  deactivate?(): void;
}

export interface ActivePluginRuntime {
  pluginId: string;
  version: string;
  /** 声明的权限：宿主据此决定暴露给页面的桥方法 */
  permissions: readonly string[];
  pages: RegisteredPluginRuntimePage[];
  commands: string[];
  /** 包声明的桥方法名（§11.2 桥自注册）：宿主按声明放行，未声明一律拒 */
  bridgeMethods: readonly string[];
  deactivate(): void;
}

export interface PluginRuntimeInput {
  pluginId: string;
  version: string;
  /** 信息性字段：记录激活时的声明权限 */
  permissions?: readonly string[];
  module: PluginRuntimeModule;
  services: PluginRuntimeServices;
  /** 事件分发器：宿主在事件发生时调用，把 payload 投给所有已激活插件的订阅者 */
  hub: EventHub;
}

export interface EventHub {
  subscribe(
    event: PluginRuntimeEventName,
    pluginId: string,
    handler: (payload: unknown) => void,
  ): { dispose(): void };
}

const ID_RE = /^[a-z0-9][a-z0-9.-]*$/;

/**
 * 激活一个代码插件。贡献被逐项校验并登记；activate 抛错或登记冲突都会让整个
 * 插件回滚到未激活态——不允许「半个插件」活着。
 */
export function activatePluginRuntime(input: PluginRuntimeInput): ActivePluginRuntime {
  const { pluginId, version, permissions, module, services, hub } = input;
  const pages: RegisteredPluginRuntimePage[] = [];
  const commands: string[] = [];
  const bridgeMethods: string[] = [];
  const cleanups: Array<() => void> = [];
  let deactivated = false;

  const guard = (): void => {
    if (deactivated) throw new Error(`插件 ${pluginId} 已停用，不能再注册贡献`);
  };

  const ctx: PluginRuntimeContext = {
    pluginId,
    campaign: services.campaign,
    storage: services.storage,
    data: services.data,
    llm: services.llm,
    agent: services.agent,
    evidence: services.evidence,
    workspace: services.workspace,
    artifact: services.artifact,
    library: services.library,
    views: {
      registerPage(page: PluginRuntimePage) {
        guard();
        if (!ID_RE.test(page.id)) throw new Error(`视图 id 不合法：${page.id}`);
        if (!page.webviewPath?.startsWith('ui/')) {
          throw new Error(`视图 ${page.id} 的 webview 路径必须在 ui/ 下`);
        }
        const fullId = `${pluginId}:${page.id}`;
        if (pages.some((existing) => existing.fullId === fullId)) {
          throw new Error(`视图重复注册：${fullId}`);
        }
        const registered: RegisteredPluginRuntimePage = {
          pluginId,
          fullId,
          id: page.id,
          title: page.title,
          webviewPath: page.webviewPath,
        };
        pages.push(registered);
        return { dispose() {
          const index = pages.indexOf(registered);
          if (index >= 0) pages.splice(index, 1);
        } };
      },
    },
    commands: {
      register(id: string, handler: CommandHandler) {
        guard();
        if (!ID_RE.test(id)) throw new Error(`命令 id 不合法：${id}`);
        if (typeof handler !== 'function') throw new Error(`命令 ${id} 的处理器必须是函数`);
        const fullId = `${pluginId}:${id}`;
        if (commands.includes(fullId)) throw new Error(`命令重复注册：${fullId}`);
        commands.push(fullId);
        return { dispose() {
          const index = commands.indexOf(fullId);
          if (index >= 0) commands.splice(index, 1);
        } };
      },
    },
    events: {
      on(event: PluginRuntimeEventName, handler: (payload: unknown) => void) {
        guard();
        if (!PLUGIN_RUNTIME_EVENTS.includes(event)) {
          throw new Error(`未开放的事件：${String(event)}`);
        }
        if (typeof handler !== 'function') throw new Error('事件处理器必须是函数');
        // 订阅的清理权在宿主：插件忘拿 disposable，deactivate 也必须能撤干净
        const subscription = hub.subscribe(event, pluginId, handler);
        cleanups.push(() => subscription.dispose());
        return subscription;
      },
    },
    bridge: {
      declare(name: string) {
        guard();
        assertPluginBridgeMethod(name);
        if (bridgeMethods.includes(name)) throw new Error(`桥方法重复声明：${name}`);
        bridgeMethods.push(name);
        return { dispose() {
          const index = bridgeMethods.indexOf(name);
          if (index >= 0) bridgeMethods.splice(index, 1);
        } };
      },
      methods() {
        return [...bridgeMethods];
      },
    },
  };

  const teardown = module.activate(ctx);
  if (typeof teardown === 'function') cleanups.push(teardown);
  cleanups.push(() => module.deactivate?.());

  return {
    pluginId,
    version,
    permissions: permissions ?? [],
    // getter：deactivate 清空内部登记后，外部看到的快照同步为空
    get pages() {
      return [...pages];
    },
    get commands() {
      return [...commands];
    },
    // 声明快照：deactivate 清空内部登记后同步为空
    get bridgeMethods() {
      return [...bridgeMethods];
    },
    deactivate() {
      if (deactivated) return;
      deactivated = true;
      pages.length = 0;
      commands.length = 0;
      bridgeMethods.length = 0;
      for (const cleanup of cleanups.reverse()) {
        try {
          cleanup();
        } catch {
          // 停用路径上的清理失败不阻断其余清理
        }
      }
    },
  };
}

/**
 * 门面命名空间可见性：权限即 API 面。基础命名空间人人可见；
 * llm / evidence 只对 manifest 声明了对应权限的插件注入（渲染层装配时使用）。
 */
export function pluginRuntimeNamespaces(permissions: readonly string[]): string[] {
  // bridge 与基础命名空间同级：声明桥方法没有权限门槛，放行与否由权限网关判。
  // data 也在这里：读写哪些集合由包自己的 manifest 声明决定，不额外挂权限。
  const namespaces = ['views', 'commands', 'events', 'campaign', 'storage', 'data', 'bridge'];
  if (permissions.includes('filesystem:workspace')) namespaces.push('workspace');
  if (permissions.includes('artifact:read')) namespaces.push('artifact');
  if (permissions.includes('llm:complete')) namespaces.push('llm', 'agent');
  if (permissions.includes('evidence:read-confirmed')) namespaces.push('evidence');
  // 话术库：打包自己选的来源类型写进用户的话术库；未声明 library:write 的包看不见它
  if (permissions.includes('library:write')) namespaces.push('library');
  return namespaces;
}

/** 内存事件总线：桌面的宿主容器与测试都用它；移动端换桥实现即可 */
export function createEventHub(): EventHub & {
  emit(event: PluginRuntimeEventName, payload?: unknown): void;
} {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    subscribe(event, pluginId, handler) {
      const key = `${event}::${pluginId}`;
      const set = listeners.get(key) ?? new Set();
      set.add(handler);
      listeners.set(key, set);
      return { dispose() {
        set.delete(handler);
      } };
    },
    emit(event, payload) {
      for (const [key, set] of listeners) {
        if (key.startsWith(`${event}::`)) {
          for (const handler of set) handler(payload);
        }
      }
    },
  };
}
