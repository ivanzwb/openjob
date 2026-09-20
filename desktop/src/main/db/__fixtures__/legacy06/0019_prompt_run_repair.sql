CREATE TABLE IF NOT EXISTS `prompt_run` (
	`id` text PRIMARY KEY NOT NULL,
	`prompt_id` text NOT NULL,
	`version_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`role` text NOT NULL,
	`model` text NOT NULL,
	`tier` text NOT NULL,
	`ok` integer NOT NULL,
	`error` text,
	`prompt_tokens` integer DEFAULT 0 NOT NULL,
	`completion_tokens` integer DEFAULT 0 NOT NULL,
	`latency_ms` integer NOT NULL,
	`output_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_prompt_run_prompt_version` ON `prompt_run` (`prompt_id`,`version_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_prompt_run_created` ON `prompt_run` (`created_at`);
