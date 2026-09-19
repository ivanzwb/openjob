/**
 * 软件工程岗位包的移动端代码入口（§7.9）：「源码」页属于本包。
 *
 * 手机端**不做执行**（§11.4）：工作区与远端拉取只在桌面存在，所以这里只声明读取本包声明的
 * repositories 数据集合 —— 页面上如实写明「链接与更新在桌面端做」，而不是摆一个点了必然报错的
 * 按钮。数据集合两端同步共用，桌面拉下来的仓库登记在手机上能看到；手机端对包数据是只读的。
 */
import type { PluginRuntimeContext } from '@core/plugins/pluginRuntime/host';

const BRIDGE_METHODS = ['data.list'] as const;

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
