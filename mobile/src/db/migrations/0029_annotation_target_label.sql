-- 与桌面 0031_annotation_target_label 同一步：标记表的跨功能汇总面收敛成通用原语后，
-- 包自己起的 target_type 宿主不认识，多一列 target_label 存包给的可读标签。
-- 历史行为 NULL，宿主认识的取值照旧从目标本身算标签，读旧数据不受影响。
ALTER TABLE `annotation` ADD `target_label` text;
