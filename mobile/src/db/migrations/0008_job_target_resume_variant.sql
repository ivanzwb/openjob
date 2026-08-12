CREATE TABLE `job_target` (
	`id` text PRIMARY KEY NOT NULL,
	`company` text NOT NULL,
	`role_title` text NOT NULL,
	`jd_raw` text NOT NULL,
	`jd_parsed` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_job_target_company` ON `job_target` (`company`,`role_title`);--> statement-breakpoint
CREATE TABLE `resume_variant` (
	`id` text PRIMARY KEY NOT NULL,
	`source_resume_id` text NOT NULL,
	`job_target_id` text NOT NULL,
	`label` text NOT NULL,
	`content_md` text NOT NULL,
	`changelog_md` text DEFAULT '' NOT NULL,
	`is_user_edited` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`source_resume_id`) REFERENCES `resume`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_target_id`) REFERENCES `job_target`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_resume_variant_target` ON `resume_variant` (`job_target_id`);--> statement-breakpoint
CREATE INDEX `idx_resume_variant_source` ON `resume_variant` (`source_resume_id`);--> statement-breakpoint
ALTER TABLE `resume` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `campaign` ADD `job_target_id` text REFERENCES `job_target`(`id`) ON UPDATE no action ON DELETE set null;
