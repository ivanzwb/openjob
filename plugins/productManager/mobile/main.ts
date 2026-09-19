/**
 * 产品经理岗位包的移动端代码入口（§7.9）：「案例训练」页属于本包。
 *
 * 手机端**不做执行**（§7）：artifact 与 LLM 原语只在桌面存在，所以这里只声明读取本包
 * 声明的 cases 数据集合——页面上如实写明「出题与评分在桌面端做」，而不是摆一个点了必然
 * 报错的按钮。数据集合两端同步共用，桌面生成的案例在手机上能看到；手机端对包数据是只读的。
 */
import type { PluginRuntimeContext } from '@core/plugins/pluginRuntime/host';

const BRIDGE_METHODS = ['data.list'] as const;

export function activate(ctx: PluginRuntimeContext): () => void {
  ctx.views.registerPage({
    id: 'case-practice',
    title: '案例训练',
    webviewPath: 'ui/practice.html',
  });

  const declared = BRIDGE_METHODS.map((method) => ctx.bridge.declare(method));
  return function deactivate() {
    for (const handle of declared) handle.dispose();
  };
}
