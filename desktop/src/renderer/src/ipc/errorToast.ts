import { useEffect } from 'react';
import { useToast } from '../components/Toast';

/**
 * 后台失败的统一出口。
 *
 * 任务与流式请求都会在用户已经切走的页面上继续跑，失败时光把错误留在仓库里
 * 等着「切回来才看见」等于没说——模型调用失败尤其不能悄悄咽下去。
 * 提示走一个模块级的通道，谁在跑、跑在哪个页面都不影响它弹出来。
 */
let notify: ((message: string) => void) | null = null;

export function reportBackgroundError(message: string): void {
  notify?.(message);
}

/** 在应用根组件调用一次，把 toast 接到上面的通道上 */
export function useBackgroundErrorToast(): void {
  const toast = useToast();
  useEffect(() => {
    notify = (message) => toast(message, { variant: 'error' });
    return () => {
      notify = null;
    };
  }, [toast]);
}
