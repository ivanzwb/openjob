CREATE TABLE `sync_row_version` (
	`table_name` text NOT NULL,
	`row_id` text NOT NULL,
	`updated_ms` integer NOT NULL,
	PRIMARY KEY(`table_name`, `row_id`)
);
--> statement-breakpoint
ALTER TABLE `sync_conflict` RENAME TO `sync_overwrite`;--> statement-breakpoint
ALTER TABLE `sync_overwrite` RENAME COLUMN `resolution` TO `kept_side`;--> statement-breakpoint
UPDATE `sync_overwrite` SET `kept_side` = 'local' WHERE `kept_side` NOT IN ('local', 'remote');--> statement-breakpoint
DROP INDEX IF EXISTS `idx_sync_conflict_run`;--> statement-breakpoint
CREATE INDEX `idx_sync_overwrite_run` ON `sync_overwrite` (`run_id`);--> statement-breakpoint
ALTER TABLE `sync_run` RENAME COLUMN `conflict_count` TO `overwrite_count`;--> statement-breakpoint
UPDATE `sync_run` SET `status` = 'success' WHERE `status` = 'conflict';--> statement-breakpoint
ALTER TABLE `sync_peer` ADD `last_full_sync_at` integer;
