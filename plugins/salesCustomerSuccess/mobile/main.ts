/**
 * 销售岗位包的移动端代码入口（§7.9）：「客户对话模拟」页属于本包。
 *
 * 手机端**不做执行**（§7）：实时对话要用桌面的 LLM 网关，这一端没有。所以这里只声明读取本包
 * 声明的 `role-play-sessions` 数据集合——页面上如实写明「对练在桌面端做」，而不是摆一个点了
 * 必然报错的按钮。数据集合两端同步共用，桌面对练过的会话在手机上能看到；手机端对包数据只读。
 */
import type { PluginRuntimeContext } from '@core/plugins/pluginRuntime/host';

const BRIDGE_METHODS = ['data.list'] as const;

export function activate(ctx: PluginRuntimeContext): () => void {
  ctx.views.registerPage({
    id: 'role-play',
    title: '客户对话模拟',
    webviewPath: 'ui/role-play.html',
  });

  const declared = BRIDGE_METHODS.map((method) => ctx.bridge.declare(method));
  return function deactivate() {
    for (const handle of declared) handle.dispose();
  };
}
