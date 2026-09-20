-- 0.6.x 老库导入的「后半段」补课：老库是在导入完成之后才补的这两件事，第一批升级过的库
-- 一条都没赶上——导入只发生一次，之后再也不会重跑。这里把同两条规则搬进迁移，让它对
-- 「已经导过、但当时还没补」的库也生效；两条都是 INSERT OR IGNORE，重跑安全。
--
-- 1) 0027 的插件化前凭据：它在空库上跑，导入进来的旧战役一个都没被标记，于是
--    db/backfill/pluginRuntime 的回填永远选不中它们——那些战役没有岗位意图、没有
--    descriptor，练习入口取不到岗位包（题型下拉空着），排程也不排插件任务。
--    只在**确实来自老库导入**的库上补（sync_meta 里有导入标记），且只补导入那一刻
--    就已经存在的战役（created_at 早于导入完成时间），不碰之后在 1.0.0 里新建的战役：
--    它们停在「还没挑岗位」是对的，不该被冒充成工程岗。
--
-- 2) 0029 的仓库登记表搬迁：同样在空库上跑，导入进来的 repo 行当时一行都不在，于是
--    「源码」页里一个仓库都没有。key 仍是旧 repo.id——包那一侧按 (集合, 键) 取数。
INSERT OR IGNORE INTO `migration_checkpoint` (`id`, `campaign_id`, `kind`, `completed_at`)
SELECT 'generic-interview-v1:prePlugin:' || c.`id`,
       c.`id`,
       'generic-interview-v1:prePlugin',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM `campaign` c
JOIN `sync_meta` m ON m.`key` = 'legacyImport:0.6.x'
WHERE c.`role_profile_id` IS NULL
  AND c.`created_at` <= CAST(json_extract(m.`value`, '$.completedAt') AS INTEGER);
--> statement-breakpoint
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
