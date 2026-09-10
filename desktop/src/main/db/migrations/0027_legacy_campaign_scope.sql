-- 划定「插件化之前就已存在」的 Campaign 集合。
--
-- 回填（src/main/db/backfill/pluginRuntime.ts）原本只按 role_profile_id IS NULL 选人，
-- 但新建 Campaign 的 role_profile_id 同样是 NULL（src/main/campaign/repository.ts），
-- 于是「刚建好、还没选岗位」的战役会在下次启动时被这段旧数据迁移盖成
-- software-engineering + source-repository，Repos 页跟着出现，整个应用又变回只面向
-- 软件工程师。回填此后只认本条迁移标记出来的这批。
--
-- 为什么标在这条迁移而不是 0023：v1.0 从未发布过，任何真实用户升级到 v1.0 时
-- 0023 与本条都在同一次启动里执行完，两个时点等价。
--
-- completed_at 在这里是「打标时刻」而非「回填完成时刻」：真正的完成凭据是
-- kind = 'generic-interview-v1' 那条 checkpoint，两者 kind 不同、互不干扰。
INSERT OR IGNORE INTO migration_checkpoint (id, campaign_id, kind, completed_at)
SELECT 'generic-interview-v1:legacy:' || c.id,
       c.id,
       'generic-interview-v1:legacy',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM campaign c
WHERE c.role_profile_id IS NULL;
