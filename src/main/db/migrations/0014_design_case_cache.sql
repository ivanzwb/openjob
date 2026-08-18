CREATE TABLE `design_case` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`requested_type` text NOT NULL,
	`interview_type` text NOT NULL,
	`related_node_name` text,
	`title` text NOT NULL,
	`scenario_md` text NOT NULL,
	`constraints` text DEFAULT '[]' NOT NULL,
	`evaluation_criteria` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaign`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_design_case_campaign_type` ON `design_case` (`campaign_id`,`requested_type`);
