CREATE TABLE `practice_session` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`node_id` text,
	`format_id` text NOT NULL,
	`protocol` text NOT NULL,
	`rubric_id` text NOT NULL,
	`role_pack_id` text NOT NULL,
	`role_pack_version` text NOT NULL,
	`config_snapshot_hash` text NOT NULL,
	`max_follow_ups` integer DEFAULT 0 NOT NULL,
	`follow_up_strategy` text DEFAULT 'adaptive' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`previous_attempt_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaign`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `knowledge_node`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_practice_session_campaign` ON `practice_session` (`campaign_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_practice_session_node` ON `practice_session` (`node_id`);
--> statement-breakpoint
CREATE TABLE `practice_turn` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`turn_index` integer NOT NULL,
	`speaker` text NOT NULL,
	`kind` text NOT NULL,
	`content_md` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `practice_session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_practice_turn_index` ON `practice_turn` (`session_id`,`turn_index`);
--> statement-breakpoint
CREATE TABLE `practice_attempt` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`node_id` text,
	`format_id` text NOT NULL,
	`rubric_id` text NOT NULL,
	`competency_ids` text DEFAULT '[]' NOT NULL,
	`question_md` text NOT NULL,
	`answer_md` text NOT NULL,
	`transcript_md` text,
	`total_score` real DEFAULT 0 NOT NULL,
	`feedback_md` text DEFAULT '' NOT NULL,
	`improved_script_md` text,
	`needs_repractice` integer DEFAULT false NOT NULL,
	`previous_attempt_id` text,
	`prompt_version_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `practice_session`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaign`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `knowledge_node`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_practice_attempt_campaign` ON `practice_attempt` (`campaign_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_practice_attempt_session` ON `practice_attempt` (`session_id`);
--> statement-breakpoint
CREATE INDEX `idx_practice_attempt_previous` ON `practice_attempt` (`previous_attempt_id`);
--> statement-breakpoint
CREATE TABLE `practice_score` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`rubric_id` text NOT NULL,
	`dimension_id` text NOT NULL,
	`dimension_label` text NOT NULL,
	`weight` real DEFAULT 0 NOT NULL,
	`critical` integer DEFAULT false NOT NULL,
	`score` integer NOT NULL,
	`anchor_md` text NOT NULL,
	`answer_quote` text NOT NULL,
	`answer_start` integer NOT NULL,
	`answer_end` integer NOT NULL,
	`rationale_md` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `practice_attempt`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_practice_score_dimension` ON `practice_score` (`attempt_id`,`dimension_id`);
