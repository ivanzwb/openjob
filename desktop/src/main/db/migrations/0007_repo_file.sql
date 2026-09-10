CREATE TABLE `repo_file` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`file_path` text NOT NULL,
	`content` text NOT NULL,
	`line_count` integer NOT NULL,
	`byte_size` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repo`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_repo_file_repo` ON `repo_file` (`repo_id`);--> statement-breakpoint
CREATE INDEX `idx_repo_file_path` ON `repo_file` (`repo_id`,`file_path`);
