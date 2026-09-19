-- 公司情报的第一列当年按软件工程岗命名为「技术栈」，但这个字段所有岗位都要用。
-- 改成岗位中立的「核心知识 / 工具地图」，取值原样保留，读旧数据不受影响。
ALTER TABLE `company_intel` RENAME COLUMN `tech_stack_md` TO `knowledge_tool_map_md`;
