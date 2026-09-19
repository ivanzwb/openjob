/**
 * 软件工程岗位包的代码入口（§7.9）：「源码」页属于本包。
 *
 * 页面能做的事全部走**通用原语**：仓库从远端拉进本包工作区（`workspace.fetch`，另需
 * `network:fetch`），目录沿 `workspace.list` 逐层浏览、文件按行区间用 `workspace.read`
 * 分页读取（带行号，不整份加载），符号与检索沿同一条工作区路径取（`workspace.*`），
 * 登记表、问答历史与索引产物存在本包声明的数据集合里（`data.*`，宿主不认识内容），
 * 问答用基础能力（`agent.ask`）且上下文由页面自己拼。建索引时再用受控补全
 * （`llm.complete`）把文件清单与符号整理成摘要与仓库地图——这是本包自己的提示词，
 * 宿主只提供端点。宿主不再为「源码」开专用通道，本包也不再依赖 `repo.*` 那套岗位通道。
 *
 * 桥方法要**声明**才够得到（§11.2 桥自注册）：下面这一串就是本包的全部请求面。声明只决定
 * 「能不能到网关」，放行与否仍由权限网关逐次判——声明 ≠ 有权限。
 */
import type { PluginRuntimeContext } from '@core/plugins/pluginRuntime/host';

const BRIDGE_METHODS = [
  'workspace.fetch',
  'workspace.delete',
  'workspace.glob',
  // 代码查看器：列目录 + 按行区间读取（都只是通用工作区原语，不含岗位专属通道）
  'workspace.list',
  'workspace.read',
  'workspace.grep',
  'workspace.symbols',
  // 登记表、问答历史与索引产物存在本包声明的数据集合里（repositories / qa-history /
  // repository-indexes）：页面按通用数据原语读写自己的行，不再走 storage.*
  'data.list',
  'data.get',
  'data.put',
  'data.delete',
  // 受控 LLM 补全：建索引时用本包自己的提示词把文件清单与符号整理成「摘要 + 仓库地图」，
  // System / User 文本由页面自己带，宿主只提供端点、审计与 JSON 解析
  'llm.complete',
  'agent.ask',
  // 用户的话术库：把选中/整段代码按本包自己的来源类型（code-ref）存进去，并取回自己
  // 存过的那几条——来源类型与标签由本包给，宿主不认识（见 ui/repositories.html）
  'library.saveSnippet',
  'library.listSnippets',
  // 标记面：本包的代码位置标记写进**宿主的跨功能标记汇总**（不再只留在本包自己的数据集合），
  // 于是它也会出现在宿主的标记面板里；目标类型（code-mark）与标签（file:line）由本包给，
  // 宿主不认识，认不出的取值按本包给的标签渲染
  'library.annotate',
  'library.listAnnotations',
  'library.deleteAnnotation',
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
