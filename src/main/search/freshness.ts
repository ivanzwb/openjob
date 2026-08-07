import type { SearchRequest, SearchResultItem } from '@shared/ipc';

/**
 * 时效处理。
 *
 * 技术文档比面经更容易骗人：一篇 2019 年讲某框架配置的文章读起来完全正常，
 * 但接口早就改了。这里不删旧结果——旧文章讲原理往往仍然对——
 * 而是算出年龄、把过时的往后压，并把日期一路带进模型上下文，让它自己加限定。
 */

const DAY = 86_400_000;

/** 把内部 freshness 枚举翻成 Tavily 的 time_range */
export function toTavilyTimeRange(
  freshness: SearchRequest['freshness'],
): 'day' | 'week' | 'month' | 'year' | undefined {
  switch (freshness) {
    case 'oneDay':
      return 'day';
    case 'oneWeek':
      return 'week';
    case 'oneMonth':
      return 'month';
    case 'oneYear':
      return 'year';
    default:
      return undefined;
  }
}

export function ageInDays(publishedAt: number | null): number | null {
  if (!publishedAt) return null;
  const days = Math.floor((Date.now() - publishedAt) / DAY);
  return days >= 0 ? days : 0;
}

/**
 * 标注年龄并把过时的技术文档往后排。
 *
 * 只对 techDocs 生效：面经越新越好但旧的也有参考价值，公司情报本身就在滚动更新，
 * 唯独技术文档存在「写的时候是对的，现在是错的」这种情况。
 * 没有发布日期的一律不判过时——猜错的代价比漏判大。
 */
export function annotateFreshness(
  results: SearchResultItem[],
  category: SearchRequest['cacheCategory'],
  staleDays: number,
): SearchResultItem[] {
  const check = category === 'techDocs' && staleDays > 0;

  for (const r of results) {
    r.ageDays = ageInDays(r.publishedAt);
    r.stale = check && r.ageDays !== null && r.ageDays > staleDays;
  }

  if (!check) return results;
  // 稳定排序：只把过时的整体挪到后面，同组内保持原有的可信度顺序
  return [...results.filter((r) => !r.stale), ...results.filter((r) => r.stale)];
}

/** 给模型看的时效标注，如「发布于 2021-03-04，已 1600 天，可能已过时」 */
export function freshnessLabel(item: SearchResultItem): string {
  if (!item.publishedAt) return '发布时间未知';
  const date = new Date(item.publishedAt).toISOString().slice(0, 10);
  const age = item.ageDays ?? ageInDays(item.publishedAt);
  const aged = age === null ? '' : `，已 ${age} 天`;
  return `发布于 ${date}${aged}${item.stale ? '，内容可能已过时，引用时请核对版本' : ''}`;
}
