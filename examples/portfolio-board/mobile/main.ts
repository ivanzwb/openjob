/**
 * 作品集看板：官方代码插件验收样本（§7.9）的移动端实现。
 *
 * 打包期由 esbuild 编译为 CJS 的 mobile/main.js；运行时在移动端 WebView 里
 * 只提供 require('openjob') 门面。与 desktop/main.ts 同构，页面布局适配触摸屏。
 */
import type { PluginRuntimeContext } from '@core/plugins/pluginRuntime/host';

export function activate(ctx: PluginRuntimeContext): () => void {
  let attachedCampaignId: string | null = null;

  ctx.events.on('campaign:attached', (payload) => {
    attachedCampaignId = (payload as { campaignId: string }).campaignId;
  });

  ctx.commands.register('portfolio.refresh', async () => {
    if (!attachedCampaignId) return { evidence: [], notes: [] };
    const evidence = await ctx.evidence?.listConfirmed(attachedCampaignId);
    const notes = JSON.parse((await ctx.storage.get('notes')) ?? '[]') as unknown[];
    return { evidence, notes };
  });

  ctx.views.registerPage({
    id: 'board',
    title: '作品集看板',
    webviewPath: 'ui/index.html',
  });

  return function deactivate() {};
}
