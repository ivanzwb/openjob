import { useCallback, useEffect, useRef, useState } from 'react';
import { decideCapabilityNavVisible, type CapabilityNavState } from '@shared/hostUi';
import { capabilityMode } from '@shared/plugins/clientView';
import { invoke } from './index';
import { useDataRefresh } from './dataVersion';

const STORAGE_PREFIX = 'openjob:capabilityNav:';

function readStored(key: string): boolean | null {
  const stored = window.localStorage.getItem(key);
  return stored === null ? null : stored === '1';
}

/**
 * 应用级导航项的能力门控。
 *
 * 能力是按 Campaign 启用的，顶部导航却只有一份，所以这里对所有 Campaign 求并集：
 * 逐个取本机能力视图，只要还有一场备考真的能用这项能力，入口就留着。判断规则本身在
 * `@shared/hostUi`，这里只负责取数与「上一次结论」的落盘。
 *
 * 结论写进 localStorage 并在下次启动时先用上：探测要走 N+1 次 IPC，冷启动时先按
 * 「不可用」渲染再把入口插回去，是一次每次开应用都能看见的抖动。
 *
 * 取数失败一律不改变结论。网络或数据库抖一下就把用户用了半年的入口摘掉，比多留一个
 * 点进去报错的入口更难解释。
 */
export function useCapabilityNav(capabilityId: string): boolean {
  const storageKey = `${STORAGE_PREFIX}${capabilityId}`;
  const [state, setState] = useState<CapabilityNavState>(() => ({
    probed: false,
    entries: [],
    lastKnownVisible: readStored(storageKey),
  }));
  // 多次 bump 会并发探测；只认最后一次发出的那轮结果，避免旧结论后到覆盖新结论
  const generation = useRef(0);

  const probe = useCallback(() => {
    const current = ++generation.current;
    void (async () => {
      const campaigns = await invoke('campaign:list', undefined);
      const entries = await Promise.all(
        campaigns.map(async (campaign) => {
          const view = await invoke('campaign:getClientCapabilityView', {
            campaignId: campaign.id,
            platform: 'desktop',
          });
          return {
            campaignId: campaign.id,
            mode: view ? capabilityMode(view, capabilityId) : null,
          };
        }),
      );
      if (current !== generation.current) return;
      setState((prev) => ({ ...prev, probed: true, entries }));
    })().catch(() => undefined);
  }, [capabilityId]);

  useEffect(() => {
    probe();
  }, [probe]);

  useDataRefresh(probe);

  const visible = decideCapabilityNavVisible(state);

  useEffect(() => {
    if (state.probed) window.localStorage.setItem(storageKey, visible ? '1' : '0');
  }, [state.probed, storageKey, visible]);

  return visible;
}
