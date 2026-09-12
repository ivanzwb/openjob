import type { HostPageId } from '@core/plugins/types';
import { Repos } from './pages/Repos';

/**
 * 宿主页面注册表：岗位包导航入口的 pageId → 本机已实现的页面组件。
 *
 * 插件不注入组件（插入点 A 的硬约束），入口能指向哪些页面由这张表封闭；
 * 新页面先在 core 的 HOST_PAGE_IDS 登记 id，再在两端实现组件并挂进这里。
 */
export const HOST_PAGES: Record<HostPageId, () => React.JSX.Element> = {
  'source-repository': Repos,
};
