/**
 * 软件工程岗位包的移动端代码入口（§7.9）：「源码」页属于本包。
 *
 * 手机端**几乎只能读**（§11.4）：写侧（链接 / 更新 / 建索引 / 打标记）留在桌面。手机自己
 * 不装插件包、也没有宿主工作区实现，所以工作区与问答都**代理到已配对的桌面端**——桌面按包
 * 声明的 filesystem:workspace 解析出本包工作区，读到的就是桌面那份检出。页面据此：
 * - 读本包声明的 repositories 数据集合与同步来的索引（`data.list`，两端共用一份）；
 * - 只读浏览 / 按行号读取配对桌面的检出（`workspace.list` / `workspace.read`）；
 * - 问源码（`agent.ask`），回答经宿主事件流推回页面；
 * - 把选中/当前行区间**存进用户的话术库**（`library.saveSnippet`，本包自己的来源类型
 *   code-ref）并取回（`library.listSnippets`）——片段落进同步的话术库，随同步回到桌面；
 * - 只读列出桌面写进标记汇总面的本包标记（`library.listAnnotations`），点一下跳回那段代码。
 * 工作区写侧（`workspace.write/delete/fetch`）与标记写侧（`library.annotate/deleteAnnotation`）
 * 本端没有，页面上不摆点了必然失败的按钮。
 */
import type { PluginRuntimeContext } from '@core/plugins/pluginRuntime/host';

const BRIDGE_METHODS = [
  'data.list',
  'workspace.list',
  'workspace.read',
  'agent.ask',
  // 话术库：手机端也能存（片段落进同步的话术库），并取回本包自己那一类来源
  'library.saveSnippet',
  'library.listSnippets',
  // 标记只读：桌面写进汇总面的那批，手机端看到的就是同一份
  'library.listAnnotations',
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
