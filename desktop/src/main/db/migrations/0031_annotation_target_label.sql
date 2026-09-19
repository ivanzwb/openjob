-- 标记的跨功能汇总面收敛成通用原语：包把自己的标记写进 annotation 表时，目标类型（target_type）
-- 是包自己起的自由字符串，宿主不认识，所以多一列 target_label 存包给的可读标签——读取侧
-- 对认不出的目标类型就按这一列渲染，没有标签则退回原始取值。历史行的这一列为 NULL，
-- 宿主认识的取值（node / explanation / question / intel）照旧从目标本身算标签，读旧数据不受影响。
ALTER TABLE `annotation` ADD `target_label` text;
