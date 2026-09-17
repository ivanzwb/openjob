/**
 * 软件工程岗位包的代码入口（§7.9）：「源码」页属于本包。
 *
 * 页面能做的事全部走**通用原语**：仓库从远端拉进本包工作区（`workspace.fetch`，另需
 * `network:fetch`），文件与符号沿同一条工作区路径取（`workspace.*`），状态存在插件私有存储里
 * （`storage.*`），问答用基础能力（`agent.ask`）且上下文由页面自己拼。宿主不再为「源码」开专用
 * 通道，本包也不再依赖 `repo.*` 那套岗位通道。
 *
 * 桥方法要**声明**才够得到（§11.2 桥自注册）：下面这一串就是本包的全部请求面。声明只决定
 * 「能不能到网关」，放行与否仍由权限网关逐次判——声明 ≠ 有权限。
 */
import type { PluginRuntimeContext } from '@core/plugins/pluginRuntime/host';

const BRIDGE_METHODS = [
  'workspace.fetch',
  'workspace.list',
  'workspace.read',
  'workspace.glob',
  'workspace.grep',
  'workspace.symbols',
  'storage.get',
  'storage.set',
  'agent.ask',
] as const;

export function activate(ctx: PluginRuntimeContext): () => void {
  ctx.views.registerPage({
    id: 'source-repository',
    title: '源码',
    webviewPath: 'ui/repositories.html',
  });

  const declared = BRIDGE_METHODS.map((method) => ctx.bridge.declare(method));
  return function deactivate() {
    for (const handle of declared) handle.dispose();
  };
}
