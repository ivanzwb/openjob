/**
 * 软件工程岗位包的移动端代码入口（§7.9）：「源码」页属于本包。
 *
 * 与桌面入口同构：打包期由 esbuild 编译为 CJS 的 mobile/main.js 入信封，运行时只依赖
 * require('openjob')。页面跑在移动端 WebView 里（触摸屏布局），仓库能力经受控桥调用
 * 宿主通道（宿主按 repository:read 权限与岗位网关逐次校验）。
 */
import type { PluginRuntimeContext } from '@core/plugins/pluginRuntime/host';

export function activate(ctx: PluginRuntimeContext): () => void {
  ctx.views.registerPage({
    id: 'source-repository',
    title: '源码',
    webviewPath: 'ui/repositories.html',
  });
  return function deactivate() {};
}
