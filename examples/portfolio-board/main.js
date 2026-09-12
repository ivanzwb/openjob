// 作品集看板：官方代码插件验收样本（§7.9）。
// 入口以 CommonJS 形式被宿主装配（进程内加载），require('openjob') 是唯一门面——
// 同一份代码在桌面与移动端都可激活。不允许 require 其它模块。
module.exports.activate = function activate(ctx) {
  let attachedCampaignId = null;

  ctx.events.on('campaign:attached', (payload) => {
    attachedCampaignId = payload.campaignId;
  });

  ctx.commands.register('portfolio.refresh', async () => {
    if (!attachedCampaignId) return { evidence: [], notes: [] };
    const evidence = await ctx.evidence.listConfirmed(attachedCampaignId);
    const notes = JSON.parse((await ctx.storage.get('notes')) ?? '[]');
    return { evidence, notes };
  });

  ctx.views.registerPage({
    id: 'board',
    title: '作品集看板',
    webviewPath: 'ui/index.html',
    slot: 'capability',
  });

  return function deactivate() {};
};
