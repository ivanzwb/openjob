-- 任务从「名字里带仓库」收敛成「材料对」，与桌面 0029_task_material 同一步：
-- material_kind 由岗位包声明、material_id 指向包自己声明数据集合里的一行。
-- 旧行的材料标识就是原来的 repo_id，RENAME 原样保留取值。
ALTER TABLE `task` ADD `material_kind` text;--> statement-breakpoint
ALTER TABLE `task` RENAME COLUMN `repo_id` TO `material_id`;
