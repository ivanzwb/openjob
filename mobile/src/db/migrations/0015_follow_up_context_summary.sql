ALTER TABLE `session` ADD `context_summary_md` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `session` ADD `context_summary_through_id` text;
--> statement-breakpoint
ALTER TABLE `session` ADD `context_summary_source_count` integer DEFAULT 0 NOT NULL;
