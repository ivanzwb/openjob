CREATE TABLE `role_profile` (
	`id` text PRIMARY KEY NOT NULL,
	`role_family` text NOT NULL,
	`role_pack_id` text NOT NULL,
	`level` text,
	`industry_pack_id` text,
	`location` text,
	`interview_language` text NOT NULL,
	`confidence` real NOT NULL,
	`user_confirmed` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_role_profile_pack` ON `role_profile` (`role_pack_id`,`industry_pack_id`);
--> statement-breakpoint
ALTER TABLE `campaign` ADD `role_profile_id` text REFERENCES `role_profile`(`id`) ON UPDATE no action ON DELETE set null;
--> statement-breakpoint
CREATE TABLE `campaign_plugin_binding` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`plugin_version` text NOT NULL,
	`config_json` text NOT NULL,
	`config_snapshot_hash` text NOT NULL,
	`revision` integer NOT NULL,
	`active_execution` integer DEFAULT true NOT NULL,
	`enabled_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaign`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_campaign_plugin_binding_revision` ON `campaign_plugin_binding` (`campaign_id`,`plugin_id`,`revision`);
--> statement-breakpoint
CREATE INDEX `idx_campaign_plugin_binding_active` ON `campaign_plugin_binding` (`campaign_id`,`active_execution`);
--> statement-breakpoint
CREATE TABLE `campaign_runtime_descriptor` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`revision` integer NOT NULL,
	`core_version` text NOT NULL,
	`role_pack` text NOT NULL,
	`industry_pack` text,
	`capabilities` text NOT NULL,
	`competency_baseline_version` text NOT NULL,
	`config_snapshot_hash` text NOT NULL,
	`resolved_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaign`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_campaign_runtime_descriptor_revision` ON `campaign_runtime_descriptor` (`campaign_id`,`revision`);
--> statement-breakpoint
CREATE INDEX `idx_campaign_runtime_descriptor_hash` ON `campaign_runtime_descriptor` (`config_snapshot_hash`);
--> statement-breakpoint
CREATE TABLE `migration_checkpoint` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`kind` text NOT NULL,
	`completed_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaign`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_migration_checkpoint_campaign_kind` ON `migration_checkpoint` (`campaign_id`,`kind`);
