-- 行业差异不再是一类可安装的插件，而是岗位包内的可选声明（RolePack.industryVariants）：
-- 这一列从「行业包插件引用」变成「岗位包内的变体键」。旧值是插件 id / 插件引用，语义已失效，
-- 一律清空——等价于「重选一次岗位」，留着只会让界面显示一个包里不存在的取值。
ALTER TABLE `role_profile` RENAME COLUMN `industry_pack_id` TO `industry_variant_id`;
--> statement-breakpoint
UPDATE `role_profile` SET `industry_variant_id` = NULL;
--> statement-breakpoint
ALTER TABLE `campaign_runtime_descriptor` RENAME COLUMN `industry_pack` TO `industry_variant_id`;
--> statement-breakpoint
UPDATE `campaign_runtime_descriptor` SET `industry_variant_id` = NULL;
