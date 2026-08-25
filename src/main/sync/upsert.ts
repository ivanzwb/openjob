/**
 * 同步落库的 upsert 子句，两端共用同一份 SQL。
 *
 * 不能用 `INSERT OR REPLACE`：REPLACE 是「先删冲突行再插」，foreign_keys = ON 时
 * 那次隐式删除会照常触发 ON DELETE CASCADE，把这一行的所有子行一起带走。
 * 而 planMerge 不查库，对端改过、本机没动过的行一律发成 insert（见 syncMerge.ts
 * 的 `if (!localRow)`），所以「对已存在的父行下发 insert」是每轮同步的常态：
 *
 * - 子行被静默删掉，用户看不到任何提示；
 * - 同一批里若还有引用这些子行的孙行 insert，整批事务会以
 *   FOREIGN KEY constraint failed 回滚，同步页只报这一句，查不到是哪张表。
 *
 * 改成 ON CONFLICT DO UPDATE 就地更新，冲突行不会被删，级联也就不会发生。
 */
export function upsertClause(pk: string, columns: string[]): string {
  const updates = columns
    .filter((c) => c !== pk)
    .map((c) => `\`${c}\` = excluded.\`${c}\``);
  if (updates.length === 0) return `ON CONFLICT(\`${pk}\`) DO NOTHING`;
  return `ON CONFLICT(\`${pk}\`) DO UPDATE SET ${updates.join(', ')}`;
}
