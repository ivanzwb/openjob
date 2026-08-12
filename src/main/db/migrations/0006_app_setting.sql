CREATE TABLE `app_setting` (
	`id` text PRIMARY KEY NOT NULL,
	`config_json` text NOT NULL,
	`secrets_json` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL
);
