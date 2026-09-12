import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveVisibleNavigation, type NavigationProbe, type ResolvedNavEntry } from '@core/hostUi';
import type { NavigationEntry } from '@core/plugins/types';
import { invoke } from './index';
import { useDataRefresh } from './dataVersion';

const STORAGE_KEY = 'openjob:navTabs';

/** 缓存的是完整入口（含 label），冷启动首帧就能按上次的标签渲染，不抖动 */
function readStoredTabs(): ResolvedNavEntry[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is ResolvedNavEntry =>
        typeof item === 'object' && item !== null && typeof (item as ResolvedNavEntry).id === 'string',
    );
  } catch {
    return [];
  }
}

/** 已安装岗位包声明的导航入口，按包声明顺序拼接 */
async function loadDeclaredEntries(): Promise<NavigationEntry[]> {
  const installed = await invoke('plugin:listInstalled', undefined);
  const packs = await Promise.all(
    installed
      .filter((plugin) => plugin.type === 'role-pack')
      .map((plugin) =>
        invoke('plugin:getRolePack', { id: plugin.id, version: plugin.version }).catch(() => null),
      ),
  );
  return packs.flatMap((pack) => pack?.navigation ?? []);
}

/**
 * 主导航能力页签槽位的取数 hook（插入点 A）。
 *
 * 判断规则在 `@core/hostUi/navigation`；这里只负责取数与「上一次结论」的落盘：
 * 探测要走 N+1 次 IPC，冷启动先按缓存渲染再收敛，避免入口先消失又插回的抖动。
 * 取数失败一律保留上一次的结论——网络或数据库抖一下就把用户用了半年的入口摘掉，
 * 比多留一个点进去报错的入口更难解释。
 */
export function useNavigationTabs(): { ready: boolean; tabs: ResolvedNavEntry[] } {
  const generation = useRef(0);
  const [data, setData] = useState<{
    declared: NavigationEntry[];
    probes: NavigationProbe[];
    ready: boolean;
  }>(() => ({ declared: [], probes: [], ready: false }));

  const reload = useCallback(() => {
    const current = ++generation.current;
    void (async () => {
      const [declared, campaigns] = await Promise.all([
        loadDeclaredEntries(),
        invoke('campaign:list', undefined),
      ]);
      const probes = await Promise.all(
        campaigns.map(async (campaign) => {
          const view = await invoke('campaign:getClientCapabilityView', {
            campaignId: campaign.id,
            platform: 'desktop',
          }).catch(() => null);
          // view 缺失（旧库未回填）不构成否定证据；本机可用的能力才算数
          return {
            campaignId: campaign.id,
            fullCapabilityIds: view?.enabledCapabilityIds ?? null,
          };
        }),
      );
      if (current !== generation.current) return;
      setData({ declared, probes, ready: true });
    })().catch(() => undefined);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useDataRefresh(reload);

  const tabs = resolveVisibleNavigation(data.declared, data.probes, {
    probed: data.ready,
    lastKnownIds: null,
  });
  const cached = data.ready ? tabs : readStoredTabs();
  const visible = data.ready ? tabs : cached;

  useEffect(() => {
    if (data.ready) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs));
    }
  }, [data.ready, tabs]);

  return { ready: data.ready, tabs: visible };
}
