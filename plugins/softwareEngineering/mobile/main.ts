/**
 * 软件工程岗位包的移动端代码入口（§7.9）：「源码」页属于本包。
 *
 * 手机端**只能读**（§11.4）：写侧（链接 / 更新 / 建索引）留在桌面。手机自己不装插件包、
 * 也没有宿主工作区实现，所以工作区与问答都**代理到已配对的桌面端**——桌面按包声明的
 * filesystem:workspace 解析出本包工作区，读到的就是桌面那份检出。页面据此：
 * - 读本包声明的 repositories 数据集合与同步来的索引（`data.list`，两端共用一份）；
 * - 只读浏览 / 按行号读取配对桌面的检出（`workspace.list` / `workspace.read`）；
 * - 问源码（`agent.ask`），回答经宿主事件流推回页面。
 * 写侧方法（`workspace.write/delete/fetch`）本端没有，页面上不摆点了必然失败的按钮。
 */
import type { PluginRuntimeContext } from '@core/plugins/pluginRuntime/host';

const BRIDGE_METHODS = ['data.list', 'workspace.list', 'workspace.read', 'agent.ask'] as const;

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
