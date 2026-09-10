CREATE TABLE `story` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`title` text NOT NULL,
	`situation_md` text DEFAULT '' NOT NULL,
	`task_md` text DEFAULT '' NOT NULL,
	`action_md` text DEFAULT '' NOT NULL,
	`result_md` text DEFAULT '' NOT NULL,
	`reflection_md` text DEFAULT '' NOT NULL,
	`competency_ids` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaign`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_story_campaign` ON `story` (`campaign_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `story_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`story_id` text NOT NULL,
	`evidence_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`story_id`) REFERENCES `story`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_story_evidence` ON `story_evidence` (`story_id`,`evidence_id`);
--> statement-breakpoint
CREATE INDEX `idx_story_evidence_evidence` ON `story_evidence` (`evidence_id`);
--> statement-breakpoint
CREATE TABLE `story_delivery` (
	`id` text PRIMARY KEY NOT NULL,
	`story_id` text NOT NULL,
	`snippet_id` text NOT NULL,
	`duration_seconds` integer NOT NULL,
	`fact_set_hash` text NOT NULL,
	`prompt_version_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`story_id`) REFERENCES `story`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`snippet_id`) REFERENCES `speech_snippet`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_story_delivery_duration` ON `story_delivery` (`story_id`,`duration_seconds`);
--> statement-breakpoint
CREATE INDEX `idx_story_delivery_snippet` ON `story_delivery` (`snippet_id`);
