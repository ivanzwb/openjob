CREATE TABLE `__new_resume_variant` (
	`id` text PRIMARY KEY NOT NULL,
	`source_resume_id` text,
	`job_target_id` text NOT NULL,
	`label` text NOT NULL,
	`content_md` text NOT NULL,
	`changelog_md` text DEFAULT '' NOT NULL,
	`preview_style` text,
	`is_user_edited` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`source_resume_id`) REFERENCES `resume`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`job_target_id`) REFERENCES `job_target`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_resume_variant` (
	`id`, `source_resume_id`, `job_target_id`, `label`, `content_md`,
	`changelog_md`, `preview_style`, `is_user_edited`, `created_at`, `updated_at`
) SELECT
	`id`, `source_resume_id`, `job_target_id`, `label`, `content_md`,
	`changelog_md`, `preview_style`, `is_user_edited`, `created_at`, `updated_at`
FROM `resume_variant`;--> statement-breakpoint
DROP TABLE `resume_variant`;--> statement-breakpoint
ALTER TABLE `__new_resume_variant` RENAME TO `resume_variant`;--> statement-breakpoint
CREATE INDEX `idx_resume_variant_target` ON `resume_variant` (`job_target_id`);--> statement-breakpoint
CREATE INDEX `idx_resume_variant_source` ON `resume_variant` (`source_resume_id`);
