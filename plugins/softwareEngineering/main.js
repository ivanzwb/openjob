// 软件工程岗位包的代码入口（§7.9）：「源码」页属于本包。
// 页面跑在 Webview 沙箱里，仓库能力经受控桥调用宿主通道（宿主按
// repository:read 权限与岗位网关逐次校验）。
module.exports.activate = function activate(ctx) {
  ctx.views.registerPage({
    id: 'source-repository',
    title: '源码',
    webviewPath: 'ui/repositories.html',
    slot: 'capability',
  });
  return function deactivate() {};
};
