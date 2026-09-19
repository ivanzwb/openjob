-- 任务从「名字里带仓库」收敛成「材料对」：material_kind 由岗位包声明、material_id 指向
-- 包自己声明数据集合里的一行。旧行的材料标识就是原来的 repo_id，RENAME 原样保留取值。
--
-- 三个旧表（repo / code_ref / repo_file）这一版**保留、不删**：它们是这次改动的回退路径，
-- 删表要等下一个版本确认数据集合承载得住之后再单独做。
ALTER TABLE `task` ADD `material_kind` text;--> statement-breakpoint
ALTER TABLE `task` RENAME COLUMN `repo_id` TO `material_id`;--> statement-breakpoint
-- 一次性把旧仓库登记表搬进「软件工程」包声明的 repositories 集合：
--   key = 旧 repo.id，value = {id, label: url, ready: status==='ready', url, status}
-- local_path 是本机专属、在另一台设备上本来就是错的，刻意不搬；
-- code_ref / repo_file 是可重建的本地索引缓存，也不搬。
-- INSERT OR IGNORE 让这条在 carrier 已经写过行、或旧表为空时都安全，可重复执行。
INSERT OR IGNORE INTO `plugin_data` (`id`, `plugin_id`, `collection`, `key`, `value_json`, `updated_at`)
SELECT 'software-engineering' || char(31) || 'repositories' || char(31) || r.`id`,
       'software-engineering',
       'repositories',
       r.`id`,
       json_object(
         'id', r.`id`,
         'label', r.`url`,
         'ready', CASE WHEN r.`status` = 'ready' THEN json('true') ELSE json('false') END,
         'url', r.`url`,
         'status', r.`status`
       ),
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM `repo` r;
