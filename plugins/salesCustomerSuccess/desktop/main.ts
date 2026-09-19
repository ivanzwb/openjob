/**
 * 销售岗位包的代码入口（§7.9）：「客户对话模拟」页属于本包。
 *
 * 页面能做的事全部走**通用原语**：客户台词用受控 LLM 网关生成（`llm.complete`，System 与
 * User 文本由页面自己带），对练会话存进本包声明的 `role-play-sessions` 数据集合（`data.*`，
 * 宿主不认识内容）。宿主不再为「客户对话」开专用通道，也不再渲染交互表单；场景素材与提示词
 * 正文都随页面资产走。
 *
 * 桥方法要**声明**才够得到（§11.2 桥自注册）：下面这一串就是本包的全部请求面。声明只决定
 * 「能不能到网关」，放行与否仍由权限网关逐次判——声明 ≠ 有权限。
 */
import type { PluginRuntimeContext } from '@core/plugins/pluginRuntime/host';

const BRIDGE_METHODS = [
  // 客户台词：System 与 User 文本由页面自己带，宿主只提供端点与审计
  'llm.complete',
  // 对练会话存在本包声明的 role-play-sessions 数据集合里：页面按通用数据原语读写自己的行
  'data.list',
  'data.get',
  'data.put',
  'data.delete',
] as const;

export function activate(ctx: PluginRuntimeContext): () => void {
  // 页面 id 归本包所有；宿主侧完整 id 由运行时拼成 `<pluginId>:role-play`
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
