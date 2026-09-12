/**
 * 软件工程岗位包的代码入口（§7.9）：「源码」页属于本包。
 *
 * 作者语言是 TypeScript：打包期编译为 CJS 的 main.js 入信封（import type 会被
 * 擦除，运行时只依赖 require('openjob')）。页面跑在 Webview 沙箱里，仓库能力
 * 经受控桥调用宿主通道（宿主按 repository:read 权限与岗位网关逐次校验）。
 */
import type { CodePluginContext } from '@core/plugins/codePlugin/host';

export function activate(ctx: CodePluginContext): () => void {
  ctx.views.registerPage({
    id: 'source-repository',
    title: '源码',
    webviewPath: 'ui/repositories.html',
  });
  return function deactivate() {};
}
