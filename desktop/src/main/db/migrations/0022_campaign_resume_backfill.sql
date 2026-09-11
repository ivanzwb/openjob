-- 战役没绑简历时推荐答案/出题 prompt 里没有候选人履历，只能输出占位模板。
-- 回填规则与新建战役的默认一致：目标岗位有优化派生版 → 绑派生版的母版
-- （prompt 取数会按 source_resume_id 命中派生版正文），否则绑最新母版。
UPDATE `campaign` SET `resume_id` = COALESCE(
  (SELECT `rv`.`source_resume_id` FROM `resume_variant` `rv`
    WHERE `rv`.`job_target_id` = `campaign`.`job_target_id`
      AND `rv`.`source_resume_id` IS NOT NULL
    ORDER BY `rv`.`updated_at` DESC, `rv`.`created_at` DESC LIMIT 1),
  (SELECT `r`.`id` FROM `resume` `r`
    ORDER BY `r`.`updated_at` DESC, `r`.`created_at` DESC LIMIT 1)
) WHERE `resume_id` IS NULL;
