import type { NavigationEntry } from '@core/plugins/types';
import { CORE_CAPABILITIES_PACK_ID } from '@core/plugins/capabilitySuite';

/**
 * 插入点 A：工程岗位的导航入口。
 *
 * pageId 指向宿主页面注册表（core 的 HOST_PAGE_IDS，v1 只有 source-repository），
 * 渲染组件由各端宿主绑定，插件不注入组件。入口可见性跟随
 * requiredCapabilityId 的启用状态（所有 Campaign 求并集）。
 */
export const navigation: NavigationEntry[] = [
  {
    id: 'se.source-repository',
    label: '源码',
    pageId: 'source-repository',
    requiredCapabilityId: CORE_CAPABILITIES_PACK_ID,
    degradedHint: '源码克隆、索引与检索需在桌面端完成；手机端可查看已同步的仓库与历史结果。',
  },
];
