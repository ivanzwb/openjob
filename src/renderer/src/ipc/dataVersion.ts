import { useEffect, useEffectEvent } from 'react';

/**
 * 全局数据版本发布/订阅。
 *
 * 渲染进程的数据页只在挂载时拉一次数据，且标签页保持挂载不卸载——
 * 主进程因外部数据落库（如手机端同步、冲突裁决、回滚）而改变数据库后，
 * 页面无从得知。这里提供一个轻量通知：主进程侧事件（sync:finished 等）
 * 触发 bumpDataVersion()，数据页用 useDataRefresh() 订阅后自动重拉。
 */
const listeners = new Set<() => void>();

/** 通知所有数据页：底层数据已变化，请重拉 */
export function bumpDataVersion(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // 单个订阅者失败不影响其它消费者
    }
  }
}

/** 订阅全局数据版本变化，返回退订函数 */
export function subscribeDataVersion(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 数据页接入点：数据版本 bump 时调用最新的 refresh 回调。
 * useEffectEvent 保证始终拿到最新的 refresh，且无需把它加入依赖数组、
 * 也不会在每次渲染时重建订阅。
 */
export function useDataRefresh(refresh: () => void): void {
  const onRefresh = useEffectEvent(refresh);
  useEffect(() => subscribeDataVersion(() => onRefresh()), []);
}