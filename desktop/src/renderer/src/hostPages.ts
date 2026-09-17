/**
 * 宿主页面注册表：岗位包导航入口的 pageId → 本机已实现的页面组件。
 *
 * 现在**是空的**：能力页由岗位包自己带的 Webview 页面提供（v3 代码插件，见 §7.9 的
 * `ctx.views.registerPage`），源码页就是这么搬进 software-engineering 包的——宿主不再
 * 为某个具体能力实现一份页面组件，也就不必认识那条能力 id。
 *
 * 表留着是因为插入点 A 的机制还在：将来确实有「只能由宿主渲染」的页面时再往这里挂，
 * 挂的时候记得 pageId 用宿主自己的名字，不要用某个能力 id。
 */
export const HOST_PAGES: Record<string, () => React.JSX.Element> = {};
