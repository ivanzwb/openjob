/**
 * 同步插入新行时，本机专属列的占位默认值。
 * planMerge 会剔除对端的 deviceLocal 列；插入时必须在本机补齐，否则 NOT NULL 会失败。
 */
export function deviceLocalInsertDefaults(
  table: string,
  syncedValues: Record<string, unknown>,
): Record<string, unknown> {
  if (table === 'repo') {
    const hasContent = Boolean(syncedValues.summary_md || syncedValues.repo_map_md);
    return {
      local_path: '',
      status: hasContent ? 'ready' : 'pending',
      indexed_at: null,
    };
  }
  return {};
}
