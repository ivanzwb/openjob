-- 手机端的「插件化之前就已存在」Campaign 标记，与桌面 0027_legacy_campaign_scope 同一份判定。
--
-- 为什么两端各自打标而不是等标记行同步过来：桌面的迁移跑在同步触发器安装之前
-- （src/main/db/index.ts 先 migrate 再 initSyncLayer），那批 INSERT 不进 sync_oplog，
-- 增量同步带不过来。标记 id 是确定性的（kind + campaign 主键），两端各自算出的是
-- 同一批行，真同步到一起也只是同主键同内容的合并。
--
-- 没有这个凭据、又没有 descriptor 的 Campaign 表示「还没选岗位」，
-- mobile/src/data/planLocal.ts 据此不排任何插件任务，而不是冒充工程岗。
INSERT OR IGNORE INTO migration_checkpoint (id, campaign_id, kind, completed_at)
SELECT 'generic-interview-v1:legacy:' || c.id,
       c.id,
       'generic-interview-v1:legacy',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM campaign c
WHERE c.role_profile_id IS NULL;
