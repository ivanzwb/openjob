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

import type { CampaignRuntimeDescriptor } from '../types';

export type CodePluginEventName =
  | 'campaign:attached'
  | 'campaign:capability-changed'
  | 'practice:completed';

export const CODE_PLUGIN_EVENTS: readonly CodePluginEventName[] = [
  'campaign:attached',
  'campaign:capability-changed',
  'practice:completed',
];

/** 插件注册的 Webview 页面：资源路径相对包根，渲染进 Webview 沙箱 */
export interface CodePluginPage {
  /** 插件内唯一；宿主侧完整 id 为 `<pluginId>:<id>` */
  id: string;
  title: string;
  /** 包内 Webview 资源路径，例如 ui/index.html */
  webviewPath: string;
}

export interface RegisteredCodePluginPage extends CodePluginPage {
  pluginId: string;
  /** 宿主侧完整 id：`<pluginId>:<id>` */
  fullId: string;
}

export type CommandHandler = (args: unknown) => Promise<unknown> | unknown;

export interface CodePluginServices {
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
}

export interface CodePluginContext {
  readonly pluginId: string;
  /** 只读指定 Campaign 的 descriptor；无 descriptor 时为 null */
  readonly campaign: CodePluginServices['campaign'];
  /** 插件私有 KV */
  readonly storage: CodePluginServices['storage'];
  views: {
    registerPage(page: CodePluginPage): { dispose(): void };
  };
  commands: {
    register(id: string, handler: CommandHandler): { dispose(): void };
  };
  events: {
    on(event: CodePluginEventName, handler: (payload: unknown) => void): { dispose(): void };
  };
}

export interface CodePluginModule {
  activate(ctx: CodePluginContext): void | (() => void);
  deactivate?(): void;
}

export interface ActiveCodePlugin {
  pluginId: string;
  version: string;
  pages: RegisteredCodePluginPage[];
  commands: string[];
  deactivate(): void;
}

export interface CodePluginInput {
  pluginId: string;
  version: string;
  module: CodePluginModule;
  services: CodePluginServices;
  /** 事件分发器：宿主在事件发生时调用，把 payload 投给所有已激活插件的订阅者 */
  hub: EventHub;
}

export interface EventHub {
  subscribe(
    event: CodePluginEventName,
    pluginId: string,
    handler: (payload: unknown) => void,
  ): { dispose(): void };
}

const ID_RE = /^[a-z0-9][a-z0-9.-]*$/;

/**
 * 激活一个代码插件。贡献被逐项校验并登记；activate 抛错或登记冲突都会让整个
 * 插件回滚到未激活态——不允许「半个插件」活着。
 */
export function activateCodePlugin(input: CodePluginInput): ActiveCodePlugin {
  const { pluginId, version, module, services, hub } = input;
  const pages: RegisteredCodePluginPage[] = [];
  const commands: string[] = [];
  const cleanups: Array<() => void> = [];
  let deactivated = false;

  const guard = (): void => {
    if (deactivated) throw new Error(`插件 ${pluginId} 已停用，不能再注册贡献`);
  };

  const ctx: CodePluginContext = {
    pluginId,
    campaign: services.campaign,
    storage: services.storage,
    views: {
      registerPage(page: CodePluginPage) {
        guard();
        if (!ID_RE.test(page.id)) throw new Error(`视图 id 不合法：${page.id}`);
        if (!page.webviewPath?.startsWith('ui/')) {
          throw new Error(`视图 ${page.id} 的 webview 路径必须在 ui/ 下`);
        }
        const fullId = `${pluginId}:${page.id}`;
        if (pages.some((existing) => existing.fullId === fullId)) {
          throw new Error(`视图重复注册：${fullId}`);
        }
        const registered: RegisteredCodePluginPage = {
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
      on(event: CodePluginEventName, handler: (payload: unknown) => void) {
        guard();
        if (!CODE_PLUGIN_EVENTS.includes(event)) {
          throw new Error(`未开放的事件：${String(event)}`);
        }
        if (typeof handler !== 'function') throw new Error('事件处理器必须是函数');
        // 订阅的清理权在宿主：插件忘拿 disposable，deactivate 也必须能撤干净
        const subscription = hub.subscribe(event, pluginId, handler);
        cleanups.push(() => subscription.dispose());
        return subscription;
      },
    },
  };

  const teardown = module.activate(ctx);
  if (typeof teardown === 'function') cleanups.push(teardown);
  cleanups.push(() => module.deactivate?.());

  return {
    pluginId,
    version,
    // getter：deactivate 清空内部登记后，外部看到的快照同步为空
    get pages() {
      return [...pages];
    },
    get commands() {
      return [...commands];
    },
    deactivate() {
      if (deactivated) return;
      deactivated = true;
      pages.length = 0;
      commands.length = 0;
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

/** 内存事件总线：桌面的宿主容器与测试都用它；移动端换桥实现即可 */
export function createEventHub(): EventHub & {
  emit(event: CodePluginEventName, payload?: unknown): void;
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
