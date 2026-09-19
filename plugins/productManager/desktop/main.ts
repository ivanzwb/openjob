/**
 * 产品经理岗位包的代码入口（§7.9）：「案例训练」页属于本包。
 *
 * 页面能做的事全部走**通用原语**：用户显式选一份表格进来（`artifact.read`，权限
 * `artifact:read`），表格解析与作答校验用本包自己的纯逻辑（页面资产 case-data.js /
 * case-analysis.js），出题 / 评分 / 推荐答案走宿主的 LLM 网关（`llm.complete`），
 * 题目与作答存进本包声明的 `cases` 数据集合（`data.*`，宿主不理解内容）。
 * 宿主不再为「产品案例」开专用通道，本包也不再依赖任何岗位通道。
 *
 * 桥方法要**声明**才够得到（§11.2 桥自注册）：下面这一串就是本包的全部请求面。
 * 声明只决定「能不能到网关」，放行与否仍由权限网关逐次判——声明 ≠ 有权限。
 */
import type { PluginRuntimeContext } from '@core/plugins/pluginRuntime/host';

const BRIDGE_METHODS = [
  // 用户显式提供的表格：请求里没有路径，选择器弹在主进程
  'artifact.read',
  // 出题 / 评分 / 推荐答案：System 与 User 文本由页面自己带，宿主只提供端点与审计
  'llm.complete',
  // 案例存在本包声明的 cases 数据集合里：页面按通用数据原语读写自己的行
  'data.list',
  'data.get',
  'data.put',
  'data.delete',
] as const;

export function activate(ctx: PluginRuntimeContext): () => void {
  // 页面 id 归本包所有；宿主侧完整 id 由运行时拼成 `<pluginId>:case-practice`
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
