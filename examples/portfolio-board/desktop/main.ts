/**
 * 作品集看板：官方代码插件验收样本（§7.9）。
 *
 * 打包期由 esbuild 编译为 CJS 的 desktop/main.js；运行时在桌面渲染进程里
 * 只提供 require('openjob') 门面。移动端那份实现见 mobile/main.ts。
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
