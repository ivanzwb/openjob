import { Loader2 } from 'lucide-react';

/** 图标按钮跑任务时顶替图标本身：纯图标按钮没有「删除中…」这种文字位置可用 */
export function Spinner({ size = 14 }: { size?: number }): React.JSX.Element {
  return <Loader2 size={size} className="animate-spin" aria-hidden />;
}
