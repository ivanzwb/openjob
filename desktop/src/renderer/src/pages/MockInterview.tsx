import { useCallback, useEffect, useState } from 'react';
import type { CampaignSummary } from '@core/ipc';
import { PageShell } from '../components/PageShell';
import { PracticeRunner } from '../components/PracticeRunner';
import { invoke } from '../ipc';
import { useDataRefresh } from '../ipc/dataVersion';

const SELECT_CLASS =
  'w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm';

/**
 * 模拟面试：一级菜单（0.6.x 的位置）。
 *
 * 练习本来就是独立入口——挑一场备考、挑题型、开练，不必先钻进某场备考的详情页。题型与评分
 * 维度仍按那场备考选定的岗位包声明展开（见 PracticeRunner），这一页只负责选备考。
 */
export function MockInterview(): React.JSX.Element {
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [campaignId, setCampaignId] = useState('');

  const refresh = useCallback(() => {
    void invoke('campaign:list', undefined).then((list) => {
      setCampaigns(list);
      // 选中的那场可能在别处被删了：不在列表里就退回第一场，不留一个空选择
      setCampaignId((prev) => (list.some((item) => item.id === prev) ? prev : (list[0]?.id ?? '')));
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useDataRefresh(refresh);

  // 关联备考与题型 / 面试语言 / 开始练习 同一条工具行：标签与选择并排（不是上下），选择
  // 吃掉剩余宽度，链接窄时随 flex-wrap 整项换行
  const campaignPicker = (
    <label className="flex min-w-0 max-w-md flex-1 items-center gap-2 whitespace-nowrap">
      <span className="text-xs text-[var(--color-muted)]">关联备考</span>
      <select
        value={campaignId}
        onChange={(e) => setCampaignId(e.target.value)}
        className={SELECT_CLASS}
      >
        {campaigns.length === 0 ? (
          <option value="">还没有备考</option>
        ) : (
          campaigns.map((item) => (
            <option key={item.id} value={item.id}>
              {item.company} · {item.roleTitle}
            </option>
          ))
        )}
      </select>
    </label>
  );

  return (
    <PageShell className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">模拟面试</h2>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          结合公司背景、岗位 JD、简历与考点清单出题；题型与评分维度按这场备考选定的岗位包展开。
        </p>
      </header>

      {campaignId ? (
        <PracticeRunner campaignId={campaignId} leading={campaignPicker} />
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">{campaignPicker}</div>
          <p className="text-sm text-[var(--color-muted)]">
            先去「备考」创建一场备考，这里才能出题。
          </p>
        </>
      )}
    </PageShell>
  );
}
