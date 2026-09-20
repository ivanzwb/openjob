CREATE TABLE `sync_conflict` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`table_name` text NOT NULL,
	`row_id` text NOT NULL,
	`field` text NOT NULL,
	`local_value` text,
	`remote_value` text,
	`local_wall_ms` integer NOT NULL,
	`remote_wall_ms` integer NOT NULL,
	`resolution` text DEFAULT 'pending' NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `sync_run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_sync_conflict_run` ON `sync_conflict` (`run_id`,`resolution`);--> statement-breakpoint
CREATE TABLE `sync_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_oplog` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`table_name` text NOT NULL,
	`row_id` text NOT NULL,
	`op` text NOT NULL,
	`wall_ms` integer NOT NULL,
	`device_id` text NOT NULL,
	`changed_fields` text
);
--> statement-breakpoint
CREATE INDEX `idx_oplog_row` ON `sync_oplog` (`table_name`,`row_id`);--> statement-breakpoint
CREATE INDEX `idx_oplog_seq` ON `sync_oplog` (`seq`);--> statement-breakpoint
CREATE TABLE `sync_peer` (
	`device_id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`platform` text NOT NULL,
	`shared_key` text NOT NULL,
	`last_address` text,
	`last_local_seq` integer DEFAULT 0 NOT NULL,
	`last_remote_seq` integer DEFAULT 0 NOT NULL,
	`last_sync_at` integer,
	`paired_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_run` (
	`id` text PRIMARY KEY NOT NULL,
	`peer_device_id` text NOT NULL,
	`direction` text NOT NULL,
	`status` text NOT NULL,
	`backup_file` text,
	`applied_count` integer DEFAULT 0 NOT NULL,
	`conflict_count` integer DEFAULT 0 NOT NULL,
	`error_message` text,
	`started_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_sync_run_started` ON `sync_run` (`started_at`);