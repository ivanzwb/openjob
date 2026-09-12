/**
 * 隐藏当前所在的页签时把用户送到别处。
 *
 * 门控是异步算出来的，用户完全可能正停在「源码」上：留在一个已经不渲染的页签里，
 * 界面就是一片空白，而导航栏上又没有任何一项是选中态。
 * 导航入口的声明与解析见 ./navigation（插入点 A）。
 */
export function nextVisibleTab<T extends string>(
  current: T,
  isVisible: (tab: T) => boolean,
  fallback: T,
): T {
  return isVisible(current) ? current : fallback;
}
