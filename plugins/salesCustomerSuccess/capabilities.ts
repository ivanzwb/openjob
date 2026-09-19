import type { CapabilityDeclaration } from '@core/plugins/types';
import { SALES_ROLE_PLAY_CAPABILITY_ID } from './ids';

/**
 * 插入点 E：销售岗位内嵌的角色扮演能力。
 *
 * 能力**不是**独立的包：这条声明就是题型 `sales.customer-role-play` 的可用性来源，
 * descriptor 里出现它、题型才排得到练习。
 *
 * 实时对话的实现在本包自己的 Webview 页面里（`desktop/ui/role-play.html`）：页面在
 * 沙箱里编排通用原语——客户台词走 `llm.complete`，会话存进本包声明的
 * `role-play-sessions` 数据集合。宿主不再渲染交互表单，也不再持有客户对话的协议与场景
 * 素材：那套宿主渲染交互（hostView / interactionRuntime / rolePlaySession）随本次搬迁
 * 一并下线。声明因此只剩它真正需要的东西——两项权限。
 */
export const capabilities: CapabilityDeclaration[] = [
  {
    id: SALES_ROLE_PLAY_CAPABILITY_ID,
    // 台词生成走 llm 网关；语音作答走麦克风。manifest.permissions 必须等于这里的并集。
    permissions: ['llm:complete', 'microphone:read'],
  },
];
