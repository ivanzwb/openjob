CREATE TABLE `annotation` (
	`id` text PRIMARY KEY NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`kind` text NOT NULL,
	`selected_text` text,
	`note_md` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_annotation_target` ON `annotation` (`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `campaign` (
	`id` text PRIMARY KEY NOT NULL,
	`company` text NOT NULL,
	`role_title` text NOT NULL,
	`jd_raw` text NOT NULL,
	`jd_parsed` text,
	`resume_id` text,
	`interview_date` text,
	`daily_minutes` integer,
	`status` text DEFAULT 'planning' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`resume_id`) REFERENCES `resume`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `code_ref` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`file_path` text NOT NULL,
	`start_line` integer NOT NULL,
	`end_line` integer NOT NULL,
	`commit_sha` text,
	`snippet` text,
	FOREIGN KEY (`repo_id`) REFERENCES `repo`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_code_ref_repo` ON `code_ref` (`repo_id`);--> statement-breakpoint
CREATE TABLE `company_intel` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`tech_stack_md` text DEFAULT '' NOT NULL,
	`interview_process_md` text DEFAULT '' NOT NULL,
	`hot_topics_md` text DEFAULT '' NOT NULL,
	`talking_points_md` text DEFAULT '' NOT NULL,
	`source_ids` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaign`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `explanation` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`tier` text NOT NULL,
	`content_md` text NOT NULL,
	`model_used` text NOT NULL,
	`source_ids` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `knowledge_node`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_explanation_node_tier` ON `explanation` (`node_id`,`tier`);--> statement-breakpoint
CREATE TABLE `interview_question` (
	`id` text PRIMARY KEY NOT NULL,
	`report_id` text NOT NULL,
	`question_text` text NOT NULL,
	`round_no` integer,
	`matched_node_id` text,
	`match_confidence` real,
	`is_blind_spot` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`report_id`) REFERENCES `interview_report`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`matched_node_id`) REFERENCES `knowledge_node`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_question_report` ON `interview_question` (`report_id`);--> statement-breakpoint
CREATE INDEX `idx_question_node` ON `interview_question` (`matched_node_id`);--> statement-breakpoint
CREATE TABLE `interview_report` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text,
	`company` text NOT NULL,
	`role_title` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text,
	`raw_text` text NOT NULL,
	`reported_at` integer,
	`credibility_weight` real DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaign`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_id`) REFERENCES `source`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_report_company` ON `interview_report` (`company`,`role_title`);--> statement-breakpoint
CREATE TABLE `knowledge_node` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`coverage_type` text NOT NULL,
	`exam_prob` real DEFAULT 0 NOT NULL,
	`difficulty` integer DEFAULT 3 NOT NULL,
	`est_minutes` integer DEFAULT 30 NOT NULL,
	`exam_forms` text DEFAULT '[]' NOT NULL,
	`mastery` real DEFAULT 0 NOT NULL,
	`mastery_source` text DEFAULT 'self' NOT NULL,
	`priority_score` real DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'todo' NOT NULL,
	`embedding` text,
	`is_user_added` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaign`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_node_campaign` ON `knowledge_node` (`campaign_id`);--> statement-breakpoint
CREATE INDEX `idx_node_parent` ON `knowledge_node` (`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_node_priority` ON `knowledge_node` (`campaign_id`,`priority_score`);--> statement-breakpoint
CREATE TABLE `message` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content_md` text NOT NULL,
	`citations` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_message_session` ON `message` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `node_edge` (
	`id` text PRIMARY KEY NOT NULL,
	`from_node_id` text NOT NULL,
	`to_node_id` text NOT NULL,
	`relation` text NOT NULL,
	FOREIGN KEY (`from_node_id`) REFERENCES `knowledge_node`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_node_id`) REFERENCES `knowledge_node`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_edge_from` ON `node_edge` (`from_node_id`);--> statement-breakpoint
CREATE INDEX `idx_edge_to` ON `node_edge` (`to_node_id`);--> statement-breakpoint
CREATE TABLE `plan_day` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`date` text NOT NULL,
	`planned_minutes` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaign`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_plan_day_campaign_date` ON `plan_day` (`campaign_id`,`date`);--> statement-breakpoint
CREATE TABLE `quiz_attempt` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`question` text NOT NULL,
	`user_answer` text NOT NULL,
	`score` integer NOT NULL,
	`feedback_md` text DEFAULT '' NOT NULL,
	`improved_script_md` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `knowledge_node`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_quiz_node` ON `quiz_attempt` (`node_id`);--> statement-breakpoint
CREATE TABLE `repo` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`local_path` text NOT NULL,
	`default_branch` text,
	`commit_sha` text,
	`languages` text DEFAULT '[]' NOT NULL,
	`repo_map_md` text,
	`summary_md` text,
	`indexed_at` integer,
	`status` text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `resume` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`raw_text` text NOT NULL,
	`parsed` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `search_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`query_hash` text NOT NULL,
	`provider` text NOT NULL,
	`params_json` text NOT NULL,
	`results_json` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`ttl_days` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_search_cache_hash` ON `search_cache` (`query_hash`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text,
	`kind` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaign`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `source` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`domain` text NOT NULL,
	`title` text NOT NULL,
	`provider` text NOT NULL,
	`credibility` integer DEFAULT 3 NOT NULL,
	`published_at` integer,
	`fetched_at` integer NOT NULL,
	`content_md` text
);
--> statement-breakpoint
CREATE INDEX `idx_source_url` ON `source` (`url`);--> statement-breakpoint
CREATE INDEX `idx_source_domain` ON `source` (`domain`);--> statement-breakpoint
CREATE TABLE `speech_snippet` (
	`id` text PRIMARY KEY NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`tier` text NOT NULL,
	`content_md` text NOT NULL,
	`is_user_edited` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_speech_source` ON `speech_snippet` (`source_type`,`source_id`);--> statement-breakpoint
CREATE TABLE `task` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_day_id` text NOT NULL,
	`node_id` text,
	`repo_id` text,
	`kind` text NOT NULL,
	`est_minutes` integer DEFAULT 20 NOT NULL,
	`actual_minutes` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`order_idx` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`plan_day_id`) REFERENCES `plan_day`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `knowledge_node`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_task_plan_day` ON `task` (`plan_day_id`,`order_idx`);--> statement-breakpoint
CREATE TABLE `tool_call` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`args` text NOT NULL,
	`result_summary` text DEFAULT '' NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`token_cost` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_tool_call_message` ON `tool_call` (`message_id`);