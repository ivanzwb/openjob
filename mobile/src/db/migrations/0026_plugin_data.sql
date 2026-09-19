CREATE TABLE `plugin_data` (
	`id` text PRIMARY KEY NOT NULL,
	`plugin_id` text NOT NULL,
	`collection` text NOT NULL,
	`key` text NOT NULL,
	`value_json` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_plugin_data_collection` ON `plugin_data` (`plugin_id`,`collection`,`updated_at`);
